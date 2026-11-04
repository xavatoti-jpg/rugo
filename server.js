// Servidor de chats en vivo por evento
const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { Server } = require("socket.io");
const { checkMessage } = require("./moderation");
const Auth = require("./auth");
const Mod = require("./mod");
const crypto = require("crypto");
Mod.start();

// Cuando alguien cambia (o un mod quita) su foto: actualizarla en vivo en todos los chats
function avatarChanged(uid, avatar) {
  for (const x of io.sockets.sockets.values()) if (x.data.userId === uid) x.data.avatar = avatar;
  Messages.setAvatar(uid, avatar);
  io.emit("avatar", { uid, avatar });
}
Auth.onAvatar(avatarChanged);

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

// Que el navegador (sobre todo Safari en iPhone) siempre busque la versión más nueva de la página
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res, file) => {
    if (file.endsWith(".html")) res.setHeader("Cache-Control", "no-cache, must-revalidate");
  },
}));
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
const Messages = require("./messages");
// Limpieza cada hora: mensajes de más de 7 días y salas que ya cerraron
setInterval(() => Messages.cleanup({ has: (id) => Boolean(Events.findRoom(id)) }).catch(() => {}), 3600e3);

function onlineCount(roomId) {
  return io.sockets.adapter.rooms.get(roomId)?.size || 0;
}

const withOnline = (e) => ({ ...e, online: onlineCount(e.id) });

// Categorías con cuántos eventos hay en vivo en cada una
app.get("/api/genres", (req, res) => {
  const events = Events.allEvents();
  res.json(Events.GENRES.map((g) => {
    const live = events.filter((e) => e.genre === g.id && e.state === "live" && !e.always && !e.ongoing && !e.custom);
    const community = events.filter((e) => e.genre === g.id && e.custom).length;
    const showing = events.filter((e) => e.genre === g.id && e.ongoing).length;
    const online = events.filter((e) => e.genre === g.id).reduce((n, e) => n + onlineCount(e.id), 0);
    return { ...g, live: live.length, showing, community, online };
  }));
});

// Inicio: todo lo que está en vivo, ordenado por popularidad (más gente primero)
app.get("/api/live", (req, res) => {
  const list = Events.allEvents()
    .map(withOnline)
    // En vivo + juegos que acaban de terminar (post-game, 2 horas).
    // Salas fijas (charla general, películas) solo salen si hay gente adentro.
    .filter((e) => (e.state === "live" && !e.always && !e.ongoing && !e.custom) || e.state === "post" || ((e.always || e.ongoing || e.custom) && e.online > 0))
    // Orden: primero lo que está en vivo (más gente primero), después los que terminaron
    .sort((a, b) => (a.state === "post") - (b.state === "post") || b.online - a.online || new Date(b.start) - new Date(a.start));
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
  res.json(data.map((f) => {
    const e = Events.findRoom(f.room_id);
    // Si el evento ya no existe, terminó
    return e ? { ...withOnline(e), saved: true } : { id: f.room_id, title: f.title, genre: f.genre, start: f.start_at, state: "done", saved: true, online: 0 };
  }));
});

app.post("/api/favorites/:roomId", async (req, res) => {
  const me = await signedIn(req, res);
  if (!me) return;
  const e = Events.findRoom(req.params.roomId);
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

// ---------- Chats creados por usuarios ----------
const Chats = require("./chats");
const createdAt = new Map();
app.post("/api/chats", express.json(), async (req, res) => {
  const me = await signedIn(req, res);
  if (!me) return;
  if (!me.profile?.username) return res.status(400).json({ error: "Pick a username first." });
  if (Mod.globalBan(me.user.id)) return res.status(403).json({ error: "Your account can't create chats." });
  if (Date.now() - (createdAt.get(me.user.id) || 0) < 20000) return res.status(429).json({ error: "Please wait a few seconds before creating another chat." });
  try {
    const { name, genre, topic, isPublic, code } = req.body || {};
    const chat = await Chats.create({ name, genre, topic, isPublic, code, owner: me.user.id, ownerName: me.profile.username });
    createdAt.set(me.user.id, Date.now());
    res.json(chat);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Código nuevo al azar (para el formulario)
app.get("/api/chats/new-code", (req, res) => {
  let code;
  do code = Chats.randomCode(); while (Chats.byCode(code));
  res.json({ code });
});

// Entrar con código
app.get("/api/chats/code/:code", (req, res) => {
  const c = Chats.byCode(req.params.code);
  if (!c) return res.status(404).json({ error: "No chat found with that code. Check it and try again." });
  res.json({ id: c.id });
});

app.get("/api/chats/mine", async (req, res) => {
  const me = await signedIn(req, res);
  if (!me) return;
  res.json(Chats.mine(me.user.id).map(withOnline));
});

// Cerrar un chat (su dueño o un moderador)
app.delete("/api/chats/:id", async (req, res) => {
  const me = await signedIn(req, res);
  if (!me) return;
  if (Chats.owner(req.params.id) !== me.user.id && !Mod.isStaff(me.profile?.role)) return res.status(403).json({ error: "Only the creator can close this chat." });
  await Chats.close(req.params.id);
  io.to(req.params.id).emit("closed");
  res.json({ ok: true });
});

// ---------- Panel de moderación ----------
app.get("/api/mod/actions", async (req, res) => {
  const me = await signedIn(req, res);
  if (!me) return;
  if (!Mod.isStaff(me.profile?.role)) return res.status(403).json({ error: "Not allowed" });
  const titles = { get: (id) => Events.findRoom(id)?.title };
  res.json(Mod.list().map((a) => ({ ...a, room_title: a.room_id ? titles.get(a.room_id) || "(ended chat)" : null })));
});

app.delete("/api/mod/actions/:id", async (req, res) => {
  const me = await signedIn(req, res);
  if (!me) return;
  if (!Mod.isStaff(me.profile?.role)) return res.status(403).json({ error: "Not allowed" });
  await Mod.remove(req.params.id);
  res.json({ ok: true });
});

// Películas en cartelera por región: ?region=US | PR
const Movies = require("./movies");
app.get("/api/movies", (req, res) => {
  const region = Movies.REGIONS[req.query.region] ? req.query.region : "US";
  const list = Movies.inRegion(region).map((m) => ({ ...m, online: onlineCount(m.id) }))
    .sort((a, b) => b.online - a.online || (b.releaseDate || "").localeCompare(a.releaseDate || ""));
  res.json({ region, regions: Movies.REGIONS, ...Movies.status(), movies: list });
});

// Próximos eventos (para la portada cuando no hay nada en vivo)
app.get("/api/next", (req, res) => {
  const list = Events.allEvents()
    .filter((e) => e.state === "upcoming" && !e.allDay && new Date(e.start) - Date.now() < 24 * 3600e3)
    .slice(0, 5)
    .map(withOnline);
  res.json(list);
});

// Eventos de una categoría: ?genre=deportes
app.get("/api/events", (req, res) => {
  const list = Events.allEvents().filter((e) => !req.query.genre || e.genre === req.query.genre);
  res.json(list.map(withOnline));
});

app.get("/api/events/:id", (req, res) => {
  const e = Events.findRoom(req.params.id);
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
    if (!Events.findRoom(roomId)) return;
    socket.data.name = null;

    if (Auth.enabled) {
      // Con cuentas: todos pueden leer; para escribir hay que iniciar sesión
      const me = await Auth.userFromToken(token).catch(() => null);
      if (me?.profile?.username) {
        socket.data.name = me.profile.username;
        socket.data.userId = me.user.id;
        socket.data.role = me.profile.role || "user";
        socket.data.avatar = Auth.effectiveAvatar(me.profile, me.user);
        socket.data.color = me.profile.name_color || null;
      }
    } else {
      // Sin cuentas configuradas: modo invitado con apodo
      const clean = String(name || "").trim().slice(0, 20);
      if (clean && !checkMessage(clean, { recent: [] }).blocked) socket.data.name = clean;
      else if (clean) socket.emit("system", "That nickname is not allowed.");
    }

    // Baneados: no pueden entrar
    const uid = socket.data.userId;
    if (uid && !Mod.isStaff(socket.data.role)) {
      const ban = Mod.globalBan(uid) || Mod.roomBan(uid, roomId);
      if (ban) return socket.emit("banned", { global: ban.room_id === null, until: ban.until, reason: ban.reason });
    }

    if (socket.data.room) {
      const old = socket.data.room;
      socket.leave(old);
      io.to(old).emit("online", onlineCount(old));
    }
    socket.data.room = roomId;
    socket.join(roomId);
    const muted = uid ? Mod.mute(uid, roomId) : null;
    socket.emit("joined", { canWrite: Boolean(socket.data.name), name: socket.data.name, role: socket.data.role || "user", mutedUntil: muted?.until || null });
    socket.emit("history", await Messages.recent(roomId));
    io.to(roomId).emit("online", onlineCount(roomId));
  });

  socket.on("message", (text) => {
    const room = socket.data.room;
    if (!room) return;
    if (!socket.data.name) return socket.emit("system", "Sign in to chat.");
    const m = socket.data.userId && Mod.mute(socket.data.userId, room);
    if (m) return socket.emit("system", m.until ? `You are muted until ${new Date(m.until).toUTCString().slice(17, 22)} UTC.` : "You are muted in this chat.");
    if (socket.data.userId && Mod.globalBan(socket.data.userId)) return socket.emit("banned", { global: true });
    const result = checkMessage(String(text || ""), socket.data);
    if (result.blocked) return socket.emit("system", result.reason);

    const msg = {
      id: crypto.randomUUID(),
      uid: socket.data.userId || null,
      role: Mod.isStaff(socket.data.role) ? socket.data.role : undefined,
      name: socket.data.name,
      avatar: socket.data.avatar || null,
      color: socket.data.color || undefined,
      text: result.text,
      at: Date.now(),
    };
    Messages.add(room, msg, socket.data.userId);
    io.to(room).emit("message", msg);
  });

  // ---------- Moderación (solo mods y admins) ----------
  socket.on("mod", async (req, reply) => {
    const done = (r) => typeof reply === "function" && reply(r);
    try {
      const room = socket.data.room;
      const { action, uid, name, messageId, minutes, reason } = req || {};
      // Quien creó el chat puede borrar, silenciar, sacar y banear en SU chat
      const isOwner = socket.data.userId && Chats.owner(room) === socket.data.userId;
      const ownerOk = isOwner && ["delete", "mute", "kick", "ban"].includes(action);
      if (!Mod.isStaff(socket.data.role) && !ownerOk) return done({ error: "Not allowed" });

      if (action === "delete") {
        await Messages.remove(room, String(messageId));
        io.to(room).emit("deleted", [String(messageId)]);
        return done({ ok: true });
      }

      if (!uid) return done({ error: "This user can't be moderated (no account)." });
      if (uid === socket.data.userId) return done({ error: "You can't moderate yourself." });
      const targetRole = await Mod.roleOf(uid);
      if (Mod.isStaff(targetRole) && socket.data.role !== "admin") return done({ error: "Only admins can moderate other moderators." });
      if (Chats.owner(room) === uid && !Mod.isStaff(socket.data.role)) return done({ error: "You can't moderate the chat's creator." });
      if (targetRole === "admin") return done({ error: "You can't moderate an admin." });

      const sockets = [...io.sockets.sockets.values()].filter((x) => x.data.userId === uid);
      const by = socket.data.userId;

      if (action === "mute") {
        const mins = [5, 60, 1440].includes(minutes) ? minutes : 5;
        await Mod.add({ userId: uid, username: name, roomId: room, kind: "mute", minutes: mins, reason, by });
        const label = mins === 5 ? "5 minutes" : mins === 60 ? "1 hour" : "24 hours";
        sockets.filter((x) => x.data.room === room).forEach((x) => x.emit("muted", { until: Date.now() + mins * 60e3, label }));
        io.to(room).emit("notice", `🔇 ${name} was muted for ${label}.`);
        return done({ ok: true });
      }

      if (action === "removephoto") {
        await Auth.removePhoto(uid, Boolean(req.blockUploads));
        avatarChanged(uid, null);
        return done({ ok: true });
      }

      if (action === "kick" || action === "ban" || action === "globalban") {
        if (action === "ban") await Mod.add({ userId: uid, username: name, roomId: room, kind: "ban", reason, by });
        if (action === "globalban") await Mod.add({ userId: uid, username: name, roomId: null, kind: "ban", reason, by });
        const affected = sockets.filter((x) => action === "globalban" || x.data.room === room);
        for (const x of affected) {
          const r = x.data.room;
          x.emit(action === "kick" ? "kicked" : "banned", { global: action === "globalban", reason });
          if (r) { x.leave(r); x.data.room = null; io.to(r).emit("online", onlineCount(r)); }
        }
        // Al banear, borrar sus mensajes recientes de la sala
        if (action !== "kick") {
          const gone = Messages.removeByUser(room, uid);
          if (gone.length) io.to(room).emit("deleted", gone);
        }
        const text = action === "kick" ? `👢 ${name} was removed from the chat.` : action === "ban" ? `🚫 ${name} was banned from this chat.` : `⛔ ${name} was banned from all chats.`;
        io.to(room).emit("notice", text);
        return done({ ok: true });
      }
      done({ error: "Unknown action" });
    } catch (err) {
      done({ error: err.message || "Something went wrong" });
    }
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
