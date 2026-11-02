# Rugo (prototipo)

Chat en vivo para cada evento: partidos de todas las ligas del día (automático, vía ESPN) y eventos especiales (Oscars, Grammys, Miss Universo…).

## Correr en tu computadora
1. Instala Node.js (nodejs.org)
2. En esta carpeta: `npm install` y luego `npm start`
3. Abre http://localhost:3000

## Archivos
- `server.js` – servidor, salas automáticas y chat en tiempo real
- `moderation.js` – filtro de insultos, spam, enlaces y límite de velocidad
- `special-events.json` – eventos que no son deportes (añade los que quieras)
- `public/index.html` – la página web

## Cuentas (Google y Facebook)
Se activan al poner estas variables en Render → Environment:
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (¡secreta! nunca la compartas)

La tabla de usuarios se crea pegando `supabase/schema.sql` en Supabase → SQL Editor.
Sin esas variables, Rugo funciona en modo invitado (apodo sin cuenta).

## Movies in theaters (TMDB)
Add `TMDB_TOKEN` (API Read Access Token from themoviedb.org) in Render → Environment.
Listings for United States and Puerto Rico refresh every 6 hours. `TMDB_MOCK=1` uses sample movies for local testing.
