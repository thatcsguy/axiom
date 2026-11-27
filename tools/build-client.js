// node tools/build-client.js   copies the client and the packages it loads into dist/, keeping their relative layout,
// so dist/ can be served as a static site (GitHub Pages). dist/index.html forwards to the client, keeping the query string.
// A static client has no game server of its own: open it with ?server=wss://your-server/ws.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), OUT = path.join(ROOT, 'dist');
fs.rmSync(OUT, { recursive: true, force: true });
for (const pkg of ['client', 'sim', 'protocol']) fs.cpSync(path.join(ROOT, 'packages', pkg), path.join(OUT, 'packages', pkg), { recursive: true, filter: (s) => !s.includes('node_modules') });
fs.writeFileSync(path.join(OUT, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Axiom</title><script>location.replace("packages/client/" + location.search)</script><a href="packages/client/">Axiom</a>\n');
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
console.log('built ' + OUT);
