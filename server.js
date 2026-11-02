// Servidor de chats en vivo por evento
const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { Server } = require("socket.io");
const { checkMessage } = require("./moderation");
const Auth = require("./auth");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));
// Librería de Supabase para el navegador (servida desde nuestro propio servidor)
app.use("/vendor", express.static(path.join(__dirname, "node_modules/@supabase/supabase-js/dist/umd")));
Auth.routes(app);

// ---------------------------------------------------------------
// 1. EVENTOS (ver events.js): salas automáticas para todos los eventos
// ---------------------------------------------------------------
const Events = require("./events");
Events.start();

// ---------------------------------------------------------------
// 2. API para el frontend
// ---------------------------------------------------------------
const history = new Map(); // roomId -> últimos mensajes

function onlineCount(roomId) {
  return io.sockets.adapter.rooms.get(roomId)?.size || 0;
}

const withOnline = (e) => ({ ...e, online: onlineCount(e.id) });

// Categorías con cuántos eventos hay en vivo en cada una
app.get("/api/genres", (req, res) => {
  const events = Events.allEvents();
  res.json(Events.GENRES.map((g) => {
    const live = events.filter((e) => e.genre === g.id && e.state === "live" && !e.always && !e.ongoing);
    const showing = events.filter((e) => e.genre === g.id && e.ongoing).length;
    const online = events.filter((e) => e.genre === g.id).reduce((n, e) => n + onlineCount(e.id), 0);
    return { ...g, live: live.length, showing, online };
  }));
});

// Inicio: todo lo que está en vivo, ordenado por popularidad (más gente primero)
app.get("/api/live", (req, res) => {
  const list = Events.allEvents()
    .map(withOnline)
    // Salas fijas (charla general, películas) solo salen si hay gente adentro
    .filter((e) => (e.state === "live" && !e.always && !e.ongoing) || ((e.always || e.ongoing) && e.online > 0))
    .sort((a, b) => b.online - a.online || new Date(b.start) - new Date(a.start));
  res.json(list);
});

// ---------- My Chats (favoritos de cada persona) ----------
const bearer = (req) => (req.headers.authorization || "").replace(/^Bearer /, "");
async function signedIn(req, res) {
  if (!Auth.enabled) { res.status(503).json({ error: "Accounts are not enabled" }); return null; }
  const me = await Auth.userFromToken(bearer(req)).catch(() => null);
  if (!me) { res.status(401).json({ error: "Not signed in" }); return null; }
  return me;
}

app.get("/api/favorites", async (req, res) => {
  const me = await signedIn(req, res);
  if (!me) return;
  const { data, error } = await Auth.admin.from("favorites").select("room_id, title, genre, start_at, created_at")
    .eq("user_id", me.user.id).order("created_at", { ascending: false });
  if (error) { console.error("Favorites load failed:", error.code, error.message); return res.status(500).json({ error: "Could not load your chats" }); }
  const now = new Map(Events.allEvents().map((e) => [e.id, e]));
  res.json(data.map((f) => {
    const e = now.get(f.room_id);
    // Si el evento ya no existe, terminó
    return e ? { ...withOnline(e), saved: true } : { id: f.room_id, title: f.title, genre: f.genre, start: f.start_at, state: "done", saved: true, online: 0 };
  }));
});

app.post("/api/favorites/:roomId", async (req, res) => {
  const me = await signedIn(req, res);
  if (!me) return;
  const e = Events.allEvents().find((x) => x.id === req.params.roomId);
  if (!e) return res.status(404).json({ error: "Room not found" });
  const { count } = await Auth.admin.from("favorites").select("*", { count: "exact", head: true }).eq("user_id", me.user.id);
  if (count >= 100) return res.status(400).json({ error: "You can save up to 100 chats." });
  const { error } = await Auth.admin.from("favorites").upsert({ user_id: me.user.id, room_id: e.id, title: e.title, genre: e.genre, start_at: e.start });
  if (error) {
    console.error("Favorites save failed:", error.code, error.message);
    const missing = error.code === "42P01" || error.code === "PGRST205" || /does not exist|could not find the table/i.test(error.message || "");
    return res.status(500).json({ error: missing ? "Could not save (favorites table is missing in the database)" : "Could not save" });
  }
  res.json({ saved: true });
});

app.delete("/api/favorites/:roomId", async (req, res) => {
  const me = await signedIn(req, res);
  if (!me) return;
  await Auth.admin.from("favorites").delete().eq("user_id", me.user.id).eq("room_id", req.params.roomId);
  res.json({ saved: false });
});

// Películas en cartelera por región: ?region=US | PR
const Movies = require("./movies");
app.get("/api/movies", (req, res) => {
  const region = Movies.REGIONS[req.query.region] ? req.query.region : "US";
  const list = Movies.inRegion(region).map((m) => ({ ...m, online: onlineCount(m.id) }))
    .sort((a, b) => b.online - a.online || (b.releaseDate || "").localeCompare(a.releaseDate || ""));
  res.json({ region, regions: Movies.REGIONS, ...Movies.status(), movies: list });
});

// Eventos de una categoría: ?genre=deportes
app.get("/api/events", (req, res) => {
  const list = Events.allEvents().filter((e) => !req.query.genre || e.genre === req.query.genre);
  res.json(list.map(withOnline));
});

app.get("/api/events/:id", (req, res) => {
  const e = Events.allEvents().find((x) => x.id === req.params.id);
  if (!e) return res.status(404).json({ error: "No encontrado" });
  res.json(withOnline(e));
});

// ---------------------------------------------------------------
// 3. CHAT en tiempo real
// ---------------------------------------------------------------
io.on("connection", (socket) => {
  socket.data.recent = []; // para limitar velocidad
  socket.data.strikes = 0;
  socket.data.mutedUntil = 0;

  socket.on("join", async ({ roomId, name, token }) => {
    if (!Events.allEvents().some((e) => e.id === roomId)) return;
    socket.data.name = null;

    if (Auth.enabled) {
      // Con cuentas: todos pueden leer; para escribir hay que iniciar sesión
      const me = await Auth.userFromToken(token).catch(() => null);
      if (me?.profile?.username) {
        socket.data.name = me.profile.username;
        socket.data.avatar = me.profile.avatar_url || me.user.user_metadata?.avatar_url || null;
      }
    } else {
      // Sin cuentas configuradas: modo invitado con apodo
      const clean = String(name || "").trim().slice(0, 20);
      if (clean && !checkMessage(clean, { recent: [] }).blocked) socket.data.name = clean;
      else if (clean) socket.emit("system", "That nickname is not allowed.");
    }

    if (socket.data.room) {
      const old = socket.data.room;
      socket.leave(old);
      io.to(old).emit("online", onlineCount(old));
    }
    socket.data.room = roomId;
    socket.join(roomId);
    socket.emit("joined", { canWrite: Boolean(socket.data.name), name: socket.data.name });
    socket.emit("history", history.get(roomId) || []);
    io.to(roomId).emit("online", onlineCount(roomId));
  });

  socket.on("message", (text) => {
    const room = socket.data.room;
    if (!room) return;
    if (!socket.data.name) return socket.emit("system", "Sign in to chat.");
    const result = checkMessage(String(text || ""), socket.data);
    if (result.blocked) return socket.emit("system", result.reason);

    const msg = {
      id: Date.now() + Math.random().toString(36).slice(2, 6),
      name: socket.data.name,
      avatar: socket.data.avatar || null,
      text: result.text,
      at: Date.now(),
    };
    const list = history.get(room) || [];
    list.push(msg);
    if (list.length > 100) list.shift();
    history.set(room, list);
    io.to(room).emit("message", msg);
  });

  // Reacciones flotantes (no se guardan como mensajes)
  const REACTIONS = ["🔥", "😱", "👏", "😂", "💯", "❤️", "🎉", "😡", "🐐", "🏀", "⚽", "🍿"];
  socket.data.reacts = [];
  socket.on("react", (emoji) => {
    const room = socket.data.room;
    if (!room || !REACTIONS.includes(emoji)) return;
    const now = Date.now();
    socket.data.reacts = socket.data.reacts.filter((t) => now - t < 2000);
    if (socket.data.reacts.length >= 8) return; // máx. 8 cada 2 segundos
    socket.data.reacts.push(now);
    io.to(room).emit("react", emoji);
  });

  socket.on("disconnecting", () => {
    const room = socket.data.room;
    if (room) setTimeout(() => io.to(room).emit("online", onlineCount(room)), 50);
  });
});

server.listen(PORT, () => console.log(`Listo en http://localhost:${PORT}`));
