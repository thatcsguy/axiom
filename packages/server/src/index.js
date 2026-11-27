// node packages/server/src/index.js [port]      (npm start)  the game server: client at http://localhost:8080/, socket at /ws
// Env: PORT (hosts like Fly.io and Render set it), HOST (default all interfaces).
import { startServer } from './server.js';

const port = +(process.argv[2] || process.env.PORT || 8080);
const s = await startServer({ port, host: process.env.HOST || undefined });
console.log(`Axiom server on http://localhost:${s.port}/  (WebSocket at /ws; open the page, share the address with friends)`);
