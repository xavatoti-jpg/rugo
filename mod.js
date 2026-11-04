// Moderación: roles (user / mod / admin), silenciar, sacar y banear.
// Los castigos se guardan en Supabase (tabla "moderation") y en memoria para ser rápidos.
const Auth = require("./auth");

let actions = []; // { id, user_id, username, room_id (null = todos los chats), kind: "mute"|"ban", until, reason, created_by, created_at }
const db = () => (Auth.enabled ? Auth.admin : null);

const isStaff = (role) => role === "mod" || role === "admin";
const active = (a) => !a.until || new Date(a.until).getTime() > Date.now();

async function load() {
  if (!db()) return;
  const { data, error } = await db().from("moderation").select("*").order("created_at", { ascending: false }).limit(2000);
  if (error) return console.error("Moderation load failed:", error.code, error.message);
  actions = data.filter(active);
}

function find(userId, roomId, kind) {
  return actions.find((a) => a.user_id === userId && a.kind === kind && active(a) && (a.room_id === null || a.room_id === roomId));
}

const globalBan = (userId) => actions.find((a) => a.user_id === userId && a.kind === "ban" && a.room_id === null && active(a));
const roomBan = (userId, roomId) => find(userId, roomId, "ban");
const mute = (userId, roomId) => find(userId, roomId, "mute");

async function add({ userId, username, roomId, kind, minutes, reason, by }) {
  const row = {
    user_id: userId,
    username,
    room_id: roomId ?? null,
    kind,
    until: minutes ? new Date(Date.now() + minutes * 60e3).toISOString() : null,
    reason: reason || null,
    created_by: by,
  };
  if (db()) {
    const { data, error } = await db().from("moderation").insert(row).select().single();
    if (error) { console.error("Moderation save failed:", error.code, error.message); throw new Error("Could not save. Is the moderation table created?"); }
    actions.unshift(data);
    return data;
  }
  const local = { id: Date.now(), created_at: new Date().toISOString(), ...row };
  actions.unshift(local);
  return local;
}

async function remove(id) {
  actions = actions.filter((a) => String(a.id) !== String(id));
  if (db()) await db().from("moderation").delete().eq("id", id);
}

function list() {
  actions = actions.filter(active);
  return actions;
}

async function roleOf(userId) {
  if (!db()) return "user";
  const { data } = await db().from("profiles").select("*").eq("id", userId).maybeSingle();
  return data?.role || "user";
}

function start() {
  load();
  setInterval(load, 5 * 60e3);
}

module.exports = { isStaff, globalBan, roomBan, mute, add, remove, list, roleOf, start };
