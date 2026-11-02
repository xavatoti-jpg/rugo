// Movies in theaters (TMDB) — one chat room per movie
// Needs TMDB_TOKEN (API Read Access Token) in Render → Environment.
// Optional: TMDB_MOCK=1 uses sample movies (for local testing only).
const TOKEN = process.env.TMDB_TOKEN;
const MOCK = process.env.TMDB_MOCK === "1";
const REGIONS = { US: "United States", PR: "Puerto Rico" };
const IMG = "https://image.tmdb.org/t/p/w342";

let movies = new Map(); // id -> movie
let nowPlaying = { US: [], PR: [] }; // region -> [ids]
let upcoming = []; // ids
let lastError = null;

async function tmdb(path, params = {}) {
  const url = new URL("https://api.themoviedb.org/3" + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}`, accept: "application/json" }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`TMDB ${res.status}`);
  return res.json();
}

function toMovie(m) {
  return {
    id: `movie-${m.id}`,
    tmdbId: m.id,
    title: m.title,
    poster: m.poster_path ? IMG + m.poster_path : null,
    releaseDate: m.release_date || null,
    rating: m.vote_average ? Math.round(m.vote_average * 10) / 10 : null,
    overview: m.overview || "",
  };
}

async function list(path, region, pages = 2) {
  const out = [];
  for (let page = 1; page <= pages; page++) {
    const data = await tmdb(path, { region, language: "en-US", page });
    out.push(...(data.results || []));
    if (page >= (data.total_pages || 1)) break;
  }
  return out;
}

async function refresh() {
  if (MOCK) return loadMock();
  if (!TOKEN) return;
  try {
    const next = new Map();
    const playing = {};
    for (const region of Object.keys(REGIONS)) {
      let results = await list("/movie/now_playing", region, 3);
      // TMDB tiene pocos datos de Puerto Rico; si casi no hay, usar la cartelera de EE.UU.
      if (region === "PR" && results.length < 8) results = await list("/movie/now_playing", "US", 3);
      results = results.filter((m) => !m.adult);
      playing[region] = results.map((m) => `movie-${m.id}`);
      for (const m of results) next.set(`movie-${m.id}`, toMovie(m));
    }
    const today = new Date().toISOString().slice(0, 10);
    const soon = (await list("/movie/upcoming", "US", 2)).filter((m) => !m.adult && m.release_date > today);
    for (const m of soon) next.set(`movie-${m.id}`, toMovie(m));
    movies = next;
    nowPlaying = playing;
    upcoming = soon.map((m) => `movie-${m.id}`);
    lastError = null;
    console.log(`Movies: US ${playing.US.length}, PR ${playing.PR.length}, upcoming ${upcoming.length}`);
  } catch (err) {
    lastError = err.message;
    console.log("Movies refresh failed:", err.message);
  }
}

function loadMock() {
  const day = (n) => new Date(Date.now() + n * 86400e3).toISOString().slice(0, 10);
  const sample = [
    [1, "Starfall", -10, 7.8], [2, "The Last Harbor", -3, 7.1], [3, "Midnight Run 2", -17, 6.5],
    [4, "Paper Kingdoms", -6, 8.2], [5, "Coquí", -2, 7.4], [6, "Overdrive", -24, 6.9],
    [7, "The Glass Garden", 3, null], [8, "Orbit", 9, null], [9, "Holiday Heist", 20, null],
  ].map(([id, title, d, r]) => ({ id: `movie-${id}`, tmdbId: id, title, poster: null, releaseDate: day(d), rating: r, overview: "" }));
  movies = new Map(sample.map((m) => [m.id, m]));
  nowPlaying = { US: sample.slice(0, 6).map((m) => m.id), PR: [sample[0], sample[1], sample[3], sample[4]].map((m) => m.id) };
  upcoming = sample.slice(6).map((m) => m.id);
}

// Eventos para el resto de la app (salas y calendario)
function asEvents() {
  const showing = new Set([...nowPlaying.US, ...nowPlaying.PR]);
  const events = [];
  for (const id of showing) {
    const m = movies.get(id);
    if (m) events.push({ id, genre: "theaters", title: m.title, category: "In theaters", league: "Now playing",
      start: (m.releaseDate || new Date().toISOString().slice(0, 10)) + "T12:00:00Z", state: "live", ongoing: true, poster: m.poster, rating: m.rating });
  }
  for (const id of upcoming) {
    const m = movies.get(id);
    if (m && !showing.has(id)) events.push({ id, genre: "theaters", title: m.title, category: "Premiere", league: "Opening in theaters",
      start: m.releaseDate + "T12:00:00Z", state: "upcoming", allDay: true, special: true, poster: m.poster });
  }
  return events;
}

function inRegion(region) {
  return (nowPlaying[region] || []).map((id) => movies.get(id)).filter(Boolean);
}

function start() {
  refresh();
  setInterval(refresh, 6 * 3600e3); // cada 6 horas
}

module.exports = { REGIONS, start, asEvents, inRegion, status: () => ({ enabled: Boolean(TOKEN) || MOCK, error: lastError }) };
