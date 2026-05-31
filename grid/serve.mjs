/* dev-only zero-dep static server for the grid playground. node grid/serve.mjs [port] */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, normalize, join } from 'node:path';

const root = process.cwd();
const port = Number(process.env.PORT || process.argv[2] || 4370);
const TYPES = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/grid/playground.html'; // entry; imports are absolute so the URL is fine
    const file = join(root, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    const body = await readFile(file);
    // no-store so the browser never serves a stale build of the ES modules on reload
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store, max-age=0' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}).listen(port, () => console.log(`grid playground → http://127.0.0.1:${port}/grid/playground.html`));
