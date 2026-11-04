// Mensajes del chat: últimos 100 en memoria (rápido) + guardados en Supabase por 7 días
// Sin Supabase configurado, solo se guardan en memoria.
const Auth = require("./auth");

const KEEP_DAYS = 7;
const PER_ROOM = 100;
const cache = new Map(); // roomId -> [mensajes]
const loading = new Map(); // roomId -> Promise (para no cargar dos veces)

const db = () => (Auth.enabled ? Auth.admin : null);

// Últimos mensajes de una sala (de memoria, o de la base de datos tras un reinicio)
async function recent(roomId) {
  if (cache.has(roomId)) return cache.get(roomId);
  if (!db()) return [];
  if (!loading.has(roomId)) {
    loading.set(roomId, (async () => {
      const { data, error } = await db().from("messages")
        .select("*")
        .eq("room_id", roomId)
        .gte("created_at", new Date(Date.now() - KEEP_DAYS * 86400e3).toISOString())
        .order("created_at", { ascending: false })
        .limit(PER_ROOM);
      if (error) {
        console.error("Messages load failed:", error.code, error.message);
        return [];
      }
      const list = data.reverse().map((m) => ({ id: m.mid || String(m.id), uid: m.user_id || null, name: m.name, avatar: m.avatar, text: m.text, at: new Date(m.created_at).getTime() }));
      // Si llegaron mensajes nuevos mientras cargaba, no perderlos
      const fresh = cache.get(roomId) || [];
      const merged = [...list, ...fresh.filter((f) => !list.some((l) => l.id === f.id))].slice(-PER_ROOM);
      cache.set(roomId, merged);
      return merged;
    })().finally(() => loading.delete(roomId)));
  }
  return loading.get(roomId);
}

function add(roomId, msg, userId) {
  const list = cache.get(roomId) || [];
  list.push(msg);
  if (list.length > PER_ROOM) list.shift();
  cache.set(roomId, list);
  if (db()) {
    db().from("messages")
      .insert({ room_id: roomId, user_id: userId || null, name: msg.name, avatar: msg.avatar, text: msg.text, mid: msg.id })
      .then(async ({ error }) => {
        if (!error) return;
        // Si la columna "mid" todavía no existe, guardar sin ella
        if (/mid/.test(error.message || "")) {
          const r = await db().from("messages").insert({ room_id: roomId, user_id: userId || null, name: msg.name, avatar: msg.avatar, text: msg.text });
          if (r.error) console.error("Message save failed:", r.error.code, r.error.message);
        } else console.error("Message save failed:", error.code, error.message);
      });
  }
}

// Borrar un mensaje (moderación)
async function remove(roomId, id) {
  const list = cache.get(roomId);
  if (list) cache.set(roomId, list.filter((m) => m.id !== id));
  if (db()) {
    const q = /^\d+$/.test(id) ? db().from("messages").delete().eq("id", id) : db().from("messages").delete().eq("mid", id);
    const { error } = await q;
    if (error) console.error("Message delete failed:", error.code, error.message);
  }
}

// Borrar todos los mensajes de una persona en una sala (al banear)
function removeByUser(roomId, uid) {
  const list = cache.get(roomId);
  if (!list) return [];
  const gone = list.filter((m) => m.uid === uid).map((m) => m.id);
  cache.set(roomId, list.filter((m) => m.uid !== uid));
  return gone;
}

// Limpieza: borrar mensajes de más de 7 días y vaciar la memoria de salas que ya no existen
async function cleanup(activeRoomIds) {
  for (const id of cache.keys()) if (!activeRoomIds.has(id)) cache.delete(id);
  if (!db()) return;
  const { error } = await db().from("messages").delete().lt("created_at", new Date(Date.now() - KEEP_DAYS * 86400e3).toISOString());
  if (error) console.error("Messages cleanup failed:", error.code, error.message);
}

module.exports = { recent, add, remove, removeByUser, cleanup, KEEP_DAYS };
