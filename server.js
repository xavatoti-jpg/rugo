// Servidor de chats en vivo por evento
const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { Server } = require("socket.io");
const { checkMessage } = require("./moderation");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------
// 1. EVENTOS: se crean salas automáticamente para todos los juegos del día
// ---------------------------------------------------------------
// Ligas de ESPN (API pública, sin clave). Se pueden añadir más.
const LEAGUES = [
  { sport: "basketball", league: "nba", label: "NBA", cat: "Baloncesto" },
  { sport: "basketball", league: "wnba", label: "WNBA", cat: "Baloncesto" },
  { sport: "basketball", league: "mens-college-basketball", label: "NCAA", cat: "Baloncesto" },
  { sport: "football", league: "nfl", label: "NFL", cat: "Fútbol americano" },
  { sport: "football", league: "college-football", label: "NCAA Football", cat: "Fútbol americano" },
  { sport: "baseball", league: "mlb", label: "MLB", cat: "Béisbol" },
  { sport: "hockey", league: "nhl", label: "NHL", cat: "Hockey" },
  { sport: "soccer", league: "eng.1", label: "Premier League", cat: "Fútbol" },
  { sport: "soccer", league: "esp.1", label: "LaLiga", cat: "Fútbol" },
  { sport: "soccer", league: "ita.1", label: "Serie A", cat: "Fútbol" },
  { sport: "soccer", league: "ger.1", label: "Bundesliga", cat: "Fútbol" },
  { sport: "soccer", league: "fra.1", label: "Ligue 1", cat: "Fútbol" },
  { sport: "soccer", league: "mex.1", label: "Liga MX", cat: "Fútbol" },
  { sport: "soccer", league: "usa.1", label: "MLS", cat: "Fútbol" },
  { sport: "soccer", league: "uefa.champions", label: "Champions League", cat: "Fútbol" },
  { sport: "mma", league: "ufc", label: "UFC", cat: "Peleas" },
];

let events = []; // { id, title, category, league, start, status }

async function fetchLeague(l) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/${l.sport}/${l.league}/scoreboard`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(res.status);
  const data = await res.json();
  return (data.events || []).map((e) => ({
    id: `${l.league}-${e.id}`,
    title: e.name || e.shortName,
    category: l.cat,
    league: l.label,
    start: e.date,
    status: e.status?.type?.description || "",
  }));
}

// Eventos especiales (Oscars, Grammys, Miss Universo…) desde un archivo
function loadSpecialEvents() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "special-events.json"), "utf8"));
  } catch {
    return [];
  }
}

function isRelevant(e) {
  // Mostrar eventos desde hace 12 h hasta dentro de 36 h
  const t = new Date(e.start).getTime();
  const now = Date.now();
  return t > now - 12 * 3600e3 && t < now + 36 * 3600e3;
}

async function refreshEvents() {
  const results = await Promise.allSettled(LEAGUES.map(fetchLeague));
  const sports = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  const failed = results.filter((r) => r.status === "rejected").length;
  // Eventos especiales: mostrar con hasta 30 días de anticipación
  const specials = loadSpecialEvents().filter((e) => {
    const t = new Date(e.start).getTime();
    return t > Date.now() - 12 * 3600e3 && t < Date.now() + 30 * 24 * 3600e3;
  });
  events = [...specials, ...sports].sort((a, b) => new Date(a.start) - new Date(b.start));

  if (sports.length === 0) {
    // Sin conexión a la API: usar ejemplos para poder probar
    events = [...specials, ...sampleEvents()].sort((a, b) => new Date(a.start) - new Date(b.start));
  }
  console.log(`Eventos: ${events.length} (ligas fallidas: ${failed}/${LEAGUES.length})`);
}

function sampleEvents() {
  const at = (h) => new Date(Date.now() + h * 3600e3).toISOString();
  return [
    { id: "demo-1", title: "Boston Celtics at Los Angeles Lakers", category: "Baloncesto", league: "NBA", start: at(-0.5), status: "En vivo" },
    { id: "demo-2", title: "Miami Heat at New York Knicks", category: "Baloncesto", league: "NBA", start: at(2), status: "Programado" },
    { id: "demo-3", title: "Real Madrid vs Barcelona", category: "Fútbol", league: "LaLiga", start: at(1), status: "Programado" },
    { id: "demo-4", title: "Yankees at Dodgers", category: "Béisbol", league: "MLB", start: at(3), status: "Programado" },
    { id: "demo-5", title: "Chiefs at Eagles", category: "Fútbol americano", league: "NFL", start: at(5), status: "Programado" },
  ];
}

refreshEvents();
setInterval(refreshEvents, 10 * 60 * 1000); // cada 10 minutos

// ---------------------------------------------------------------
// 2. API para el frontend
// ---------------------------------------------------------------
const history = new Map(); // roomId -> últimos mensajes

function onlineCount(roomId) {
  return io.sockets.adapter.rooms.get(roomId)?.size || 0;
}

app.get("/api/events", (req, res) => {
  res.json(events.map((e) => ({ ...e, online: onlineCount(e.id) })));
});

app.get("/api/events/:id", (req, res) => {
  const e = events.find((x) => x.id === req.params.id);
  if (!e) return res.status(404).json({ error: "No encontrado" });
  res.json({ ...e, online: onlineCount(e.id) });
});

// ---------------------------------------------------------------
// 3. CHAT en tiempo real
// ---------------------------------------------------------------
io.on("connection", (socket) => {
  socket.data.recent = []; // para limitar velocidad
  socket.data.strikes = 0;
  socket.data.mutedUntil = 0;

  socket.on("join", ({ roomId, name }) => {
    if (!events.some((e) => e.id === roomId)) return;
    const clean = String(name || "").trim().slice(0, 20);
    if (!clean || checkMessage(clean, socket.data).blocked) {
      return socket.emit("system", "Ese apodo no está permitido.");
    }
    if (socket.data.room) socket.leave(socket.data.room);
    socket.data.room = roomId;
    socket.data.name = clean;
    socket.join(roomId);
    socket.emit("history", history.get(roomId) || []);
    io.to(roomId).emit("online", onlineCount(roomId));
  });

  socket.on("message", (text) => {
    const room = socket.data.room;
    if (!room) return;
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
