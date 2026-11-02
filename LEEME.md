# EnVivo Chat (prototipo)

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
