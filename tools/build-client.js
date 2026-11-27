// node tools/build-client.js   copies the client and the packages it loads into dist/, keeping their relative layout,
// so dist/ can be served as a static site (GitHub Pages). dist/index.html forwards to the client.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), OUT = path.join(ROOT, 'dist');
fs.rmSync(OUT, { recursive: true, force: true });
for (const pkg of ['client', 'sim', 'protocol']) fs.cpSync(path.join(ROOT, 'packages', pkg), path.join(OUT, 'packages', pkg), { recursive: true, filter: (s) => !s.includes('node_modules') });
fs.writeFileSync(path.join(OUT, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=packages/client/"><title>Axiom</title><a href="packages/client/">Axiom</a>\n');
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
console.log('built ' + OUT);
