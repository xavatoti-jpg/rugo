// Moderación: filtro de insultos, spam, enlaces y límite de velocidad

// Lista básica (español e inglés). Se puede ampliar en cualquier momento.
const BAD_WORDS = [
  "puta", "puto", "pendejo", "pendeja", "cabron", "cabrón", "mierda", "coño", "verga",
  "maricon", "maricón", "joder", "gilipollas", "culero", "culera", "hijueputa", "malparido",
  "pinche", "mamaguevo",
  "fuck", "fucking", "shit", "bitch", "asshole", "cunt", "dick", "faggot", "nigger", "nigga",
  "retard", "whore", "slut", "bastard",
];

// Normaliza trucos comunes: "p.u.t.a", "PUUUTA", "pvt4", acentos
function normalize(s) {
  return s
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[4@]/g, "a").replace(/3/g, "e").replace(/[1!|]/g, "i")
    .replace(/0/g, "o").replace(/[5$]/g, "s").replace(/7/g, "t").replace(/v/g, "u")
    .replace(/(.)\1{2,}/g, "$1$1");
}

const normalizedBad = BAD_WORDS.map((w) => normalize(w));

function hasBadWord(text) {
  // Une letras sueltas separadas: "p.u.t.o" / "p u t o" -> "puto"
  const n = normalize(text).replace(/(?<=\b[a-zñ])[^a-zñ]+(?=[a-zñ]\b)/g, "");
  const words = n.split(/[^a-zñ]+/).filter(Boolean);
  const joined = normalize(text).replace(/[^a-zñ]/g, "");
  return normalizedBad.some(
    (bad) => words.some((w) => w === bad || w.replace(/(.)\1+/g, "$1") === bad.replace(/(.)\1+/g, "$1")) ||
      (bad.length >= 5 && joined.includes(bad)) // detecta "p u t a" separado
  );
}

const LINK_RE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|ly|gg|xyz|ru|tk)\b)/i;

function checkMessage(raw, state) {
  const now = Date.now();
  const text = raw.replace(/\s+/g, " ").trim();

  if (state.mutedUntil > now) {
    const s = Math.ceil((state.mutedUntil - now) / 1000);
    return { blocked: true, reason: `Estás silenciado por ${s} segundos.` };
  }
  if (!text) return { blocked: true, reason: "" };
  if (text.length > 300) return { blocked: true, reason: "Mensaje demasiado largo (máx. 300)." };

  // Límite de velocidad: máx. 5 mensajes en 10 segundos
  state.recent = (state.recent || []).filter((m) => now - m.at < 10000);
  if (state.recent.length >= 5) return strike(state, "Vas muy rápido. Espera un momento.");

  // Mensaje repetido
  if (state.recent.some((m) => m.text.toLowerCase() === text.toLowerCase())) {
    return strike(state, "No repitas el mismo mensaje.");
  }
  // Muchas MAYÚSCULAS o caracteres repetidos
  const letters = text.replace(/[^a-zA-ZÀ-ÿ]/g, "");
  if (letters.length > 12 && letters === letters.toUpperCase() && text.length > 20) {
    return { blocked: true, reason: "Evita escribir todo en mayúsculas." };
  }
  if (/(.)\1{9,}/.test(text)) return strike(state, "Mensaje parece spam.");
  if (LINK_RE.test(text)) return strike(state, "No se permiten enlaces.");
  if (hasBadWord(text)) return strike(state, "Tu mensaje contiene lenguaje no permitido.");

  state.recent.push({ text, at: now });
  return { blocked: false, text };
}

// 3 infracciones = silenciado; cada vez más tiempo
function strike(state, reason) {
  state.strikes = (state.strikes || 0) + 1;
  if (state.strikes % 3 === 0) {
    const minutes = state.strikes / 3; // 1 min, 2 min, 3 min…
    state.mutedUntil = Date.now() + minutes * 60000;
    return { blocked: true, reason: `${reason} Silenciado por ${minutes} minuto(s).` };
  }
  return { blocked: true, reason };
}

module.exports = { checkMessage, hasBadWord };
