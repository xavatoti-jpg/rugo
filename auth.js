// Cuentas de usuario con Supabase (Google y Facebook)
// Se activa cuando existen estas variables de entorno (en Render → Environment):
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
// Sin ellas, Rugo sigue funcionando con apodos (modo invitado).
const { createClient } = require("@supabase/supabase-js");
const { hasBadWord } = require("./moderation");

const URL = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const enabled = Boolean(URL && ANON && SERVICE);

const admin = enabled ? createClient(URL, SERVICE, { auth: { persistSession: false } }) : null;

// Caché corto para no preguntar a Supabase en cada mensaje
const cache = new Map(); // token -> { user, profile, at }

async function userFromToken(token) {
  if (!enabled || !token) return null;
  const hit = cache.get(token);
  if (hit && Date.now() - hit.at < 5 * 60e3) return hit;
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) return null;
  const { data: profile } = await admin.from("profiles").select("*").eq("id", data.user.id).maybeSingle();
  const entry = { user: data.user, profile, at: Date.now() };
  cache.set(token, entry);
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  return entry;
}

// Colores que se pueden elegir para el nombre en el chat
const NAME_COLORS = ["#ff6b6b", "#ff9f43", "#feca57", "#1dd1a1", "#48dbfb", "#54a0ff", "#9b5cff", "#ff6bcb", "#c8d6e5"];

function validUsername(name) {
  if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) return "Use 3 to 20 letters, numbers or _ (no spaces).";
  if (hasBadWord(name.replace(/_/g, " ")) || hasBadWord(name)) return "That username is not allowed.";
  return null;
}

function routes(app) {
  // Datos públicos que necesita el navegador para iniciar sesión
  app.get("/api/config", (req, res) => {
    res.json(enabled ? { auth: true, supabaseUrl: URL, supabaseAnonKey: ANON } : { auth: false });
  });

  const bearer = (req) => (req.headers.authorization || "").replace(/^Bearer /, "");

  // ¿Quién soy?
  app.get("/api/me", async (req, res) => {
    const me = await userFromToken(bearer(req));
    if (!me) return res.status(401).json({ error: "Not signed in" });
    const p = me.profile || {};
    const photo = p.avatar_url || me.user.user_metadata?.avatar_url || null;
    res.json({
      id: me.user.id, username: p.username || null, role: p.role || "user",
      avatar: p.show_photo === false ? null : photo, photo,
      showPhoto: p.show_photo !== false, nameColor: p.name_color || null,
      email: me.user.email || null, provider: me.user.app_metadata?.provider || null,
      joined: p.created_at || me.user.created_at || null,
    });
  });

  // Settings: color del nombre y foto de perfil
  app.patch("/api/profile", require("express").json(), async (req, res) => {
    const token = bearer(req);
    const me = await userFromToken(token);
    if (!me?.profile?.username) return res.status(401).json({ error: "Not signed in" });
    const changes = {};
    if ("nameColor" in (req.body || {})) {
      const c = req.body.nameColor;
      if (c !== null && !NAME_COLORS.includes(c)) return res.status(400).json({ error: "Invalid color" });
      changes.name_color = c;
    }
    if ("showPhoto" in (req.body || {})) changes.show_photo = Boolean(req.body.showPhoto);
    const { error } = await admin.from("profiles").update(changes).eq("id", me.user.id);
    if (error) {
      console.error("Profile update failed:", error.code, error.message);
      return res.status(500).json({ error: /column/.test(error.message || "") ? "Settings need a database update (run the new SQL)." : "Could not save. Please try again." });
    }
    for (const [k, v] of cache) if (v.user.id === me.user.id) cache.delete(k);
    res.json({ ok: true });
  });

  // Borrar mi cuenta (para siempre)
  app.delete("/api/account", async (req, res) => {
    const me = await userFromToken(bearer(req));
    if (!me) return res.status(401).json({ error: "Not signed in" });
    const { error } = await admin.auth.admin.deleteUser(me.user.id);
    if (error) {
      console.error("Account delete failed:", error.message);
      return res.status(500).json({ error: "Could not delete the account. Please contact us." });
    }
    for (const [k, v] of cache) if (v.user.id === me.user.id) cache.delete(k);
    res.json({ ok: true });
  });

  // Elegir nombre de usuario (solo la primera vez)
  app.post("/api/profile", require("express").json(), async (req, res) => {
    const token = bearer(req);
    const me = await userFromToken(token);
    if (!me) return res.status(401).json({ error: "Not signed in" });
    if (me.profile?.username) return res.status(400).json({ error: "You already have a username." });

    const username = String(req.body?.username || "").trim();
    const problem = validUsername(username);
    if (problem) return res.status(400).json({ error: problem });

    const { error } = await admin.from("profiles").insert({
      id: me.user.id,
      username,
      avatar_url: me.user.user_metadata?.avatar_url || null,
    });
    if (error) {
      const taken = error.code === "23505";
      return res.status(400).json({ error: taken ? "That username is taken. Try another one." : "Could not save. Please try again." });
    }
    cache.delete(token);
    res.json({ username });
  });
}

module.exports = { enabled, userFromToken, routes, admin, NAME_COLORS };
