/*
 * dev-only ALWAYS-ON dashboard server with LIVE RELOAD (NOT shipped).
 *   node grid/_devserve.mjs [port]      (default 4380)
 *
 * Zero deps. Serves the worktree statically AND:
 *   • watches grid/ + lib/ recursively → on any change, pushes an SSE "reload"
 *   • auto-injects a tiny live-reload client into every .html response, so the
 *     dashboard (and any review surface) refreshes itself ~150ms after I edit a file
 *   • preserves scroll position across reloads, so your place in the page is kept
 *   • '/' → the dashboard
 *
 * Pair with launchd (com.animayte.dashboard) for true always-on (survives crashes,
 * logout, reboot). See grid/_dashboard-ctl.sh.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { extname, normalize, join } from 'node:path';

const root = process.cwd();
const port = Number(process.env.PORT || process.argv[2] || 4380);
const TYPES = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

// ── live-reload bus ────────────────────────────────────────────────────────────────
const clients = new Set();
function broadcast(type) { for (const res of clients) { try { res.write(`data: ${type}\n\n`); } catch {} } }
let debounce = null, lastChange = 'boot';
for (const dir of ['grid', 'lib', 'assets']) {
  try {
    watch(join(root, dir), { recursive: true }, (_e, file) => {
      lastChange = file || dir;
      clearTimeout(debounce);
      debounce = setTimeout(() => broadcast('reload'), 120);
    });
  } catch (e) { console.warn(`watch ${dir}: ${e.message}`); }
}
// heartbeat keeps EventSource happy + lets us notice dead clients
setInterval(() => broadcast('ping'), 25000);

const CLIENT = `
<script>(function(){
  try {
    var es = new EventSource('/__livereload');
    es.addEventListener('message', function(e){
      if (e.data === 'reload') { try { sessionStorage.setItem('__scrollY', String(scrollY)); } catch(_){} location.reload(); }
    });
    es.addEventListener('error', function(){ /* EventSource auto-reconnects */ });
    window.addEventListener('load', function(){
      try { var y = sessionStorage.getItem('__scrollY'); if (y !== null) { scrollTo(0, parseInt(y,10)||0); sessionStorage.removeItem('__scrollY'); } } catch(_){}
    });
    // tiny corner badge so you can SEE the live link is alive
    window.addEventListener('DOMContentLoaded', function(){
      var b = document.createElement('div');
      b.textContent = '● live';
      b.style.cssText = 'position:fixed;bottom:8px;right:10px;z-index:9999;font:10px ui-monospace,monospace;color:#6fe09a;background:rgba(10,14,26,.7);border:1px solid rgba(111,224,154,.4);border-radius:999px;padding:2px 8px;pointer-events:none';
      es.addEventListener('error', function(){ b.textContent='○ reconnecting'; b.style.color='#e6a817'; });
      es.addEventListener('open', function(){ b.textContent='● live'; b.style.color='#6fe09a'; });
      document.body.appendChild(b);
    });
  } catch(_){}
})();</script>`;

createServer(async (req, res) => {
  // SSE endpoint
  if (req.url === '/__livereload') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'access-control-allow-origin': '*' });
    res.write('retry: 800\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  // health endpoint (for launchd / ctl script)
  if (req.url === '/__health') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`ok clients=${clients.size} lastChange=${lastChange}`); return; }
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/grid/dashboard.html';
    const file = join(root, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    let body = await readFile(file);
    const type = TYPES[extname(file)] || 'application/octet-stream';
    if (type === 'text/html') {
      const html = body.toString();
      body = Buffer.from(html.includes('</body>') ? html.replace('</body>', CLIENT + '\n</body>') : html + CLIENT);
    }
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store, max-age=0' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`animayte dashboard (live) → http://localhost:${port}/  ·  watching grid/ lib/ assets/`));
