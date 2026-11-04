// Eventos y categorías de Rugo
const fs = require("fs");
const Movies = require("./movies");
const path = require("path");

// Categorías principales (lo primero que ve el usuario)
const GENRES = [
  { id: "sports", name: "Sports", emoji: "🏟️", color: "#ff6b35" },
  { id: "theaters", name: "In Theaters", emoji: "🍿", color: "#e17055" },
  { id: "movies", name: "Movies & TV", emoji: "🎬", color: "#e84393" },
  { id: "gaming", name: "Gaming", emoji: "🎮", color: "#6c5ce7" },
  { id: "music", name: "Music", emoji: "🎵", color: "#00b894" },
  { id: "shows", name: "Awards & Shows", emoji: "🏆", color: "#fdcb6e" },
];

// Ligas de ESPN (API pública, sin clave). Se pueden añadir más.
const LEAGUES = [
  { sport: "basketball", league: "nba", label: "NBA", cat: "Basketball" },
  { sport: "basketball", league: "wnba", label: "WNBA", cat: "Basketball" },
  { sport: "basketball", league: "mens-college-basketball", label: "NCAA", cat: "Basketball" },
  { sport: "football", league: "nfl", label: "NFL", cat: "Football" },
  { sport: "football", league: "college-football", label: "NCAA Football", cat: "Football" },
  { sport: "baseball", league: "mlb", label: "MLB", cat: "Baseball" },
  { sport: "hockey", league: "nhl", label: "NHL", cat: "Hockey" },
  { sport: "soccer", league: "eng.1", label: "Premier League", cat: "Soccer" },
  { sport: "soccer", league: "esp.1", label: "LaLiga", cat: "Soccer" },
  { sport: "soccer", league: "ita.1", label: "Serie A", cat: "Soccer" },
  { sport: "soccer", league: "ger.1", label: "Bundesliga", cat: "Soccer" },
  { sport: "soccer", league: "fra.1", label: "Ligue 1", cat: "Soccer" },
  { sport: "soccer", league: "mex.1", label: "Liga MX", cat: "Soccer" },
  { sport: "soccer", league: "usa.1", label: "MLS", cat: "Soccer" },
  { sport: "soccer", league: "uefa.champions", label: "Champions League", cat: "Soccer" },
  { sport: "mma", league: "ufc", label: "UFC", cat: "MMA" },
];

const DAYS_AHEAD = 7;
const POSTGAME_HOURS = 2; // la sala sigue abierta 2 horas después del final
const HOUR = 3600e3;

// Datos por día: { "20261102": [eventos] }
let sportsByDay = {};
let usingSamples = false;

const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");

async function fetchLeagueDay(l, day) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/${l.sport}/${l.league}/scoreboard?dates=${day}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(res.status);
  const data = await res.json();
  return (data.events || []).map((e) => {
    const st = e.status?.type || {};
    return {
      id: `${l.league}-${e.id}`,
      genre: "sports",
      title: e.name || e.shortName,
      category: l.cat,
      league: l.label,
      start: e.date,
      // Pospuestos o cancelados: ESPN los marca como "post", pero no se jugaron
      state: /POSTPONED|CANCELED|CANCELLED|SUSPENDED|FORFEIT/.test(st.name || "") ? "done"
        : st.state === "in" ? "live" : st.state === "post" ? "post" : "upcoming",
      detail: st.shortDetail || "",
      score: scoreOf(e),
      teams: teamsOf(e, l.sport),
    };
  });
}

// Equipos para el banner: nombre, logo, color y marcador.
// En fútbol se muestra primero el local ("Real Madrid vs Barcelona"); en EE.UU. el visitante ("Celtics at Lakers").
function teamsOf(e, sport) {
  const c = e.competitions?.[0]?.competitors;
  if (!c || c.length !== 2) return null;
  const pre = e.status?.type?.state === "pre";
  const side = (x) => {
    const t = x.team || x.athlete || {};
    const hex = (v) => (/^[0-9a-f]{6}$/i.test(v || "") ? "#" + v : null);
    return {
      name: t.shortDisplayName || t.displayName || t.name || "",
      abbr: t.abbreviation || (t.displayName || "").split(" ").map((w) => w[0]).join("").slice(0, 3).toUpperCase(),
      logo: t.logo || t.logos?.[0]?.href || t.headshot?.href || t.flag?.href || null,
      color: hex(t.color) || "#3a3a4a",
      alt: hex(t.alternateColor),
      score: pre ? null : x.score ?? null,
      winner: Boolean(x.winner),
    };
  };
  const home = c.find((x) => x.homeAway === "home") || c[0];
  const away = c.find((x) => x.homeAway === "away") || c[1];
  return sport === "soccer" ? [side(home), side(away)] : [side(away), side(home)];
}

function scoreOf(e) {
  const c = e.competitions?.[0]?.competitors;
  if (!c || c.length !== 2 || e.status?.type?.state === "pre") return "";
  const away = c.find((x) => x.homeAway === "away") || c[1];
  const home = c.find((x) => x.homeAway === "home") || c[0];
  return `${away.team?.abbreviation} ${away.score} - ${home.score} ${home.team?.abbreviation}`;
}

async function refreshDays(days) {
  let ok = 0;
  for (const day of days) {
    const results = await Promise.allSettled(LEAGUES.map((l) => fetchLeagueDay(l, day)));
    ok += results.filter((r) => r.status === "fulfilled").length;
    const list = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    if (results.some((r) => r.status === "fulfilled")) sportsByDay[day] = list;
  }
  return ok;
}

// Hoy y ayer (partidos de la noche) se actualizan seguido para saber qué está en vivo
async function refreshLive() {
  const now = new Date();
  const ok = await refreshDays([ymd(new Date(now - 86400e3)), ymd(now)]);
  usingSamples = ok === 0;
  console.log(`En vivo actualizado (${ok} respuestas)${usingSamples ? " — usando ejemplos" : ""}`);
}

// El calendario (próximos 7 días) se actualiza con menos frecuencia
async function refreshCalendar() {
  const days = [];
  for (let i = 1; i <= DAYS_AHEAD; i++) days.push(ymd(new Date(Date.now() + i * 86400e3)));
  await refreshDays(days);
  // Borrar días viejos
  const keep = new Set([ymd(new Date(Date.now() - 86400e3)), ymd(new Date()), ...days]);
  for (const d of Object.keys(sportsByDay)) if (!keep.has(d)) delete sportsByDay[d];
}

// Eventos especiales (Oscars, Grammys, Miss Universo…) desde un archivo
function specialEvents() {
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(path.join(__dirname, "special-events.json"), "utf8"));
  } catch {}
  const now = Date.now();
  return list.map((e) => {
    const start = new Date(e.start).getTime();
    const end = start + (e.hours || 4) * HOUR;
    const state = now < start ? "upcoming" : now < end ? "live" : now < end + POSTGAME_HOURS * HOUR ? "post" : "done";
    return { ...e, special: true, state, endedAt: state === "post" ? end : undefined };
  });
}

// Salas generales: siempre abiertas, una por categoría
function generalRooms() {
  return GENRES.map((g) => ({
    id: `general-${g.id}`,
    genre: g.id,
    title: `${g.name} General Chat`,
    category: "General",
    league: "Always open",
    start: new Date().toISOString(),
    state: "live",
    always: true,
  }));
}

function sampleEvents() {
  const at = (h) => new Date(Date.now() + h * HOUR).toISOString();
  return [
    { id: "demo-1", title: "Boston Celtics at Los Angeles Lakers", category: "Basketball", league: "NBA", start: at(-0.5), state: "live", detail: "2nd Quarter", score: "BOS 48 - 51 LAL",
      teams: [{ name: "Celtics", abbr: "BOS", color: "#007a33", score: "48", logo: "https://a.espncdn.com/i/teamlogos/nba/500/bos.png" }, { name: "Lakers", abbr: "LAL", color: "#552583", score: "51", logo: "https://a.espncdn.com/i/teamlogos/nba/500/lal.png" }] },
    { id: "demo-2", title: "Real Madrid vs Barcelona", category: "Soccer", league: "LaLiga", start: at(-1), state: "live", detail: "67'", score: "RMA 1 - 1 BAR",
      teams: [{ name: "Real Madrid", abbr: "RMA", color: "#febe10", score: "1", logo: "https://a.espncdn.com/i/teamlogos/soccer/500/86.png" }, { name: "Barcelona", abbr: "BAR", color: "#a50044", score: "1", logo: "https://a.espncdn.com/i/teamlogos/soccer/500/83.png" }] },
    { id: "demo-3", title: "Miami Heat at New York Knicks", category: "Basketball", league: "NBA", start: at(3), state: "upcoming",
      teams: [{ name: "Heat", abbr: "MIA", color: "#98002e", score: null, logo: "https://a.espncdn.com/i/teamlogos/nba/500/mia.png" }, { name: "Knicks", abbr: "NYK", color: "#006bb6", score: null, logo: "https://a.espncdn.com/i/teamlogos/nba/500/ny.png" }] },
    { id: "demo-4", title: "Chiefs at Eagles", category: "Football", league: "NFL", start: at(26), state: "upcoming" },
    { id: "demo-5", title: "Yankees at Dodgers", category: "Baseball", league: "MLB", start: at(50), state: "upcoming" },
    { id: "demo-6", title: "Warriors at Suns", category: "Basketball", league: "NBA", start: at(-3), state: "post", detail: "Final", score: "GSW 112 - 108 PHX",
      teams: [{ name: "Warriors", abbr: "GSW", color: "#1d428a", score: "112", winner: true, logo: "https://a.espncdn.com/i/teamlogos/nba/500/gs.png" }, { name: "Suns", abbr: "PHX", color: "#e56020", score: "108", logo: "https://a.espncdn.com/i/teamlogos/nba/500/phx.png" }] },
  ].map((e) => ({ genre: "sports", ...e }));
}

// Cuándo terminó cada juego (la primera vez que ESPN lo marcó como final)
const finishedAt = new Map();
function withPostgame(e) {
  if (e.state !== "post") return e;
  const start = new Date(e.start).getTime();
  if (!finishedAt.has(e.id)) finishedAt.set(e.id, Date.now());
  // Si el servidor se reinició, no sabemos la hora exacta: un juego dura ~3 h como máximo razonable
  const ended = Math.min(finishedAt.get(e.id), start + 5 * HOUR);
  return Date.now() - ended < POSTGAME_HOURS * HOUR ? { ...e, endedAt: ended } : { ...e, state: "done" };
}

function allEvents() {
  const sports = (usingSamples ? sampleEvents() : dedupe(Object.values(sportsByDay).flat())).map(withPostgame);
  const limit = Date.now() + (DAYS_AHEAD + 1) * 86400e3;
  return [...generalRooms(), ...specialEvents(), ...Movies.asEvents(), ...sports]
    // Los especiales (Oscars, etc.) salen aunque falten semanas; los partidos, solo 7 días
    .filter((e) => e.state !== "done" && (e.special || new Date(e.start).getTime() < limit))
    .sort((a, b) => new Date(a.start) - new Date(b.start));
}

function dedupe(list) {
  const seen = new Map();
  for (const e of list) seen.set(e.id, e);
  return [...seen.values()];
}

function start() {
  Movies.start();
  refreshLive().then(refreshCalendar);
  setInterval(refreshLive, 2 * 60 * 1000); // cada 2 minutos
  setInterval(refreshCalendar, 60 * 60 * 1000); // cada hora
}

module.exports = { GENRES, allEvents, start };
