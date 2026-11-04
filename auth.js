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

// Avatares de la galería de Rugo (archivos en public/avatars/<id>.svg)
const PRESETS = ["lion", "tiger", "eagle", "shark", "wolf", "bear", "fox", "goat", "fire", "crown", "basketball", "soccer", "football", "baseball", "popcorn", "gamepad", "music", "star"];

// La foto que se muestra en los chats según lo que eligió la persona
function providerPhoto(p, user) {
  return user?.user_metadata?.avatar_url || user?.user_metadata?.picture || p?.avatar_url || null;
}
function effectiveAvatar(p, user) {
  const kind = p?.avatar_kind || (p?.show_photo === false ? "none" : "provider");
  if (kind === "upload" && p.custom_avatar) return p.custom_avatar;
  if (kind === "preset" && PRESETS.includes(p.custom_avatar)) return `/avatars/${p.custom_avatar}.svg`;
  if (kind === "provider") return providerPhoto(p, user);
  return null;
}
const forget = (uid) => { for (const [k, v] of cache) if (v.user.id === uid) cache.delete(k); };

// Quitar la foto subida (la persona o un moderador)
async function deleteUploaded(p) {
  if (p?.avatar_path) await admin.storage.from("avatars").remove([p.avatar_path]).catch(() => {});
}
async function removePhoto(uid, blockUploads) {
  const { data: p } = await admin.from("profiles").select("*").eq("id", uid).maybeSingle();
  await deleteUploaded(p);
  const changes = { avatar_kind: "none", custom_avatar: null, avatar_path: null };
  if (blockUploads) changes.photo_banned = true;
  const { error } = await admin.from("profiles").update(changes).eq("id", uid);
  if (error) throw new Error(/column/.test(error.message || "") ? "Run the new SQL for profile pictures first." : "Could not remove the photo.");
  forget(uid);
}

let onAvatarChange = () => {};

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
    res.json({
      id: me.user.id, username: p.username || null, role: p.role || "user",
      avatar: effectiveAvatar(p, me.user), photo: providerPhoto(p, me.user),
      avatarKind: p.avatar_kind || (p.show_photo === false ? "none" : "provider"),
      preset: p.avatar_kind === "preset" ? p.custom_avatar : null, presets: PRESETS,
      photoBanned: Boolean(p.photo_banned), nameColor: p.name_color || null,
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
    if ("avatarKind" in (req.body || {})) {
      const kind = req.body.avatarKind;
      if (kind === "preset") {
        if (!PRESETS.includes(req.body.preset)) return res.status(400).json({ error: "Invalid avatar" });
        changes.custom_avatar = req.body.preset;
      } else if (kind === "provider" || kind === "none") changes.custom_avatar = null;
      else return res.status(400).json({ error: "Invalid option" });
      changes.avatar_kind = kind;
      changes.avatar_path = null;
      await deleteUploaded(me.profile);
    }
    const { error } = await admin.from("profiles").update(changes).eq("id", me.user.id);
    if (error) {
      console.error("Profile update failed:", error.code, error.message);
      return res.status(500).json({ error: /column/.test(error.message || "") ? "Settings need a database update (run the new SQL)." : "Could not save. Please try again." });
    }
    forget(me.user.id);
    if (changes.avatar_kind) onAvatarChange(me.user.id, effectiveAvatar({ ...me.profile, ...changes }, me.user));
    res.json({ ok: true });
  });

  // Subir foto de perfil (el navegador ya la recortó a 256×256 JPEG)
  const lastUpload = new Map();
  app.post("/api/avatar", require("express").json({ limit: "700kb" }), async (req, res) => {
    const me = await userFromToken(bearer(req));
    if (!me?.profile?.username) return res.status(401).json({ error: "Not signed in" });
    if (me.profile.photo_banned) return res.status(403).json({ error: "A moderator turned off photo uploads for your account." });
    if (Date.now() - (lastUpload.get(me.user.id) || 0) < 10000) return res.status(429).json({ error: "Please wait a few seconds and try again." });
    const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(req.body?.image || "");
    if (!m) return res.status(400).json({ error: "Please choose a JPG or PNG image." });
    const buf = Buffer.from(m[2], "base64");
    const magic = buf.subarray(0, 4).toString("hex");
    const okType = magic.startsWith("ffd8") || magic === "89504e47" || buf.subarray(8, 12).toString() === "WEBP";
    if (!okType || buf.length > 500 * 1024) return res.status(400).json({ error: "That image can't be used. Try another one." });
    lastUpload.set(me.user.id, Date.now());

    const ext = m[1] === "jpeg" ? "jpg" : m[1];
    const path = `${me.user.id}/${Date.now()}.${ext}`;
    const up = await admin.storage.from("avatars").upload(path, buf, { contentType: "image/" + m[1], cacheControl: "31536000", upsert: false });
    if (up.error) {
      console.error("Avatar upload failed:", up.error.message);
      return res.status(500).json({ error: /bucket/i.test(up.error.message || "") ? "Photo storage is not set up yet (run the new SQL)." : "Upload failed. Please try again." });
    }
    const url = admin.storage.from("avatars").getPublicUrl(path).data.publicUrl;
    await deleteUploaded(me.profile);
    const { error } = await admin.from("profiles").update({ avatar_kind: "upload", custom_avatar: url, avatar_path: path }).eq("id", me.user.id);
    if (error) {
      console.error("Avatar save failed:", error.message);
      return res.status(500).json({ error: /column/.test(error.message || "") ? "Run the new SQL for profile pictures first." : "Could not save. Please try again." });
    }
    forget(me.user.id);
    onAvatarChange(me.user.id, url);
    res.json({ ok: true, avatar: url });
  });

  // Borrar mi cuenta (para siempre)
  app.delete("/api/account", async (req, res) => {
    const me = await userFromToken(bearer(req));
    if (!me) return res.status(401).json({ error: "Not signed in" });
    await deleteUploaded(me.profile);
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

module.exports = {
  enabled, userFromToken, routes, admin, NAME_COLORS, PRESETS, effectiveAvatar, removePhoto,
  onAvatar: (fn) => { onAvatarChange = fn; },
};
