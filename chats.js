// Chats creados por los usuarios (públicos o privados con código)
// Se guardan en Supabase (tabla "user_chats"). Quien lo crea es su moderador.
const crypto = require("crypto");
const Auth = require("./auth");
const { hasBadWord } = require("./moderation");

const GENRES = ["sports", "theaters", "movies", "gaming", "music", "shows", "other"];
const DAYS_OPEN = 30; // un chat creado dura 30 días (o hasta que lo cierre su dueño)
const MAX_PER_USER = 5;
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // sin 0/O ni 1/I para no confundir

let chats = new Map(); // id -> chat
const db = () => (Auth.enabled ? Auth.admin : null);

const randomCode = (n = 6) => Array.from(crypto.randomBytes(n), (b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
const alive = (c) => !c.closed_at && new Date(c.expires_at).getTime() > Date.now();

async function load() {
  if (!db()) return;
  const { data, error } = await db().from("user_chats").select("*").is("closed_at", null).gt("expires_at", new Date().toISOString()).limit(5000);
  if (error) return console.error("Chats load failed:", error.code, error.message);
  chats = new Map(data.map((c) => [c.id, c]));
}

// Como "evento" para el resto de la app (salas, listas, favoritos)
function toEvent(c) {
  return {
    id: c.id, genre: c.genre, title: c.name,
    category: c.topic || "Community", league: c.is_public ? "Community chat" : "Private chat",
    start: c.created_at, state: "live", custom: true, isPublic: c.is_public,
    code: c.code, owner: c.owner, ownerName: c.owner_name,
  };
}

function get(id) {
  const c = chats.get(id);
  return c && alive(c) ? toEvent(c) : null;
}
const owner = (id) => chats.get(id)?.owner || null;
const publicEvents = () => [...chats.values()].filter((c) => alive(c) && c.is_public).map(toEvent);
const byCode = (code) => [...chats.values()].find((c) => alive(c) && c.code === String(code || "").trim().toUpperCase()) || null;
const mine = (uid) => [...chats.values()].filter((c) => alive(c) && c.owner === uid).map(toEvent);

async function create({ name, genre, topic, isPublic, code, owner, ownerName }) {
  if (!db()) throw new Error("Accounts are not enabled.");
  name = String(name || "").replace(/\s+/g, " ").trim();
  topic = String(topic || "").replace(/\s+/g, " ").trim().slice(0, 30) || null;
  code = String(code || "").trim().toUpperCase() || randomCode();
  if (name.length < 3 || name.length > 60) throw new Error("The chat name needs 3 to 60 characters.");
  if (!GENRES.includes(genre)) throw new Error("Pick a category.");
  if (!/^[A-Z0-9]{4,12}$/.test(code)) throw new Error("The code needs 4 to 12 letters or numbers (no spaces).");
  if (hasBadWord(name) || (topic && hasBadWord(topic)) || hasBadWord(code)) throw new Error("That name or code is not allowed.");
  if (mine(owner).length >= MAX_PER_USER) throw new Error(`You can have up to ${MAX_PER_USER} open chats. Close one first.`);
  if (byCode(code)) throw new Error("That code is already taken. Try another one.");

  const row = {
    id: "u-" + crypto.randomBytes(8).toString("hex"),
    code, name, genre, topic, is_public: Boolean(isPublic), owner, owner_name: ownerName,
    expires_at: new Date(Date.now() + DAYS_OPEN * 86400e3).toISOString(),
  };
  const { data, error } = await db().from("user_chats").insert(row).select().single();
  if (error) {
    console.error("Chat create failed:", error.code, error.message);
    if (error.code === "23505") throw new Error("That code is already taken. Try another one.");
    throw new Error(/user_chats|relation|does not exist/i.test(error.message || "") ? "Creating chats needs a database update (run the new SQL)." : "Could not create the chat. Please try again.");
  }
  chats.set(data.id, data);
  return toEvent(data);
}

async function close(id) {
  const c = chats.get(id);
  if (!c) return;
  c.closed_at = new Date().toISOString();
  chats.delete(id);
  if (db()) await db().from("user_chats").update({ closed_at: c.closed_at }).eq("id", id);
}

function start() {
  load();
  setInterval(load, 10 * 60e3);
}

module.exports = { start, get, owner, publicEvents, byCode, mine, create, close, randomCode, GENRES };
