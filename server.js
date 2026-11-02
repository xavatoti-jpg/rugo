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
    const live = events.filter((e) => e.genre === g.id && e.state === "live" && !e.always);
    const online = events.filter((e) => e.genre === g.id).reduce((n, e) => n + onlineCount(e.id), 0);
    return { ...g, live: live.length, online };
  }));
});

// Inicio: todo lo que está en vivo, ordenado por popularidad (más gente primero)
app.get("/api/live", (req, res) => {
  const list = Events.allEvents()
    .map(withOnline)
    .filter((e) => (e.state === "live" && !e.always) || (e.always && e.online > 0))
    .sort((a, b) => b.online - a.online || new Date(b.start) - new Date(a.start));
  res.json(list);
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
      if (me?.profile?.username) socket.data.name = me.profile.username;
    } else {
      // Sin cuentas configuradas: modo invitado con apodo
      const clean = String(name || "").trim().slice(0, 20);
      if (clean && !checkMessage(clean, { recent: [] }).blocked) socket.data.name = clean;
      else if (clean) socket.emit("system", "Ese apodo no está permitido.");
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
    if (!socket.data.name) return socket.emit("system", "Inicia sesión para escribir en el chat.");
    const result = checkMessage(String(text || ""), socket.data);
    if (result.blocked) return socket.emit("system", result.reason);

    const msg = {
      id: Date.now() + Math.random().toString(36).slice(2, 6),
      name: socket.data.name,
      text: result.text,
      at: Date.now(),
    };
    const list = history.get(room) || [];
    list.push(msg);
    if (list.length > 100) list.shift();
    history.set(room, list);
    io.to(room).emit("message", msg);
  });

  socket.on("disconnecting", () => {
    const room = socket.data.room;
    if (room) setTimeout(() => io.to(room).emit("online", onlineCount(room)), 50);
  });
});

server.listen(PORT, () => console.log(`Listo en http://localhost:${PORT}`));
