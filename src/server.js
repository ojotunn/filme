// Servidor do FILME: site, quadros como PNG, estado e o distribuidor por WebSocket.
// DATA_DIR sobrescreve onde grava (as provas apontam para um descartável).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Frames } from './frames.js';
import { Scheduler } from './scheduler.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8440);
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const BENCH = path.join(DATA_DIR, 'bench.jsonl');

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? Number(process.env[k]) : d);
const frames = new Frames({ W: env('FILM_W', 1024), H: env('FILM_H', 576), TILE: 64, frames: env('FILM_FRAMES', 1440), targetSpp: env('TARGET_SPP', 1024), dataDir: DATA_DIR });
const sched = new Scheduler(frames, { window: env('WINDOW', 2), tol: env('TOL', 0.35), expireS: env('EXPIRE_S', 60), assignTimeoutS: env('ASSIGN_TIMEOUT_S', 120), maxInflight: env('MAX_INFLIGHT', 8) });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' };
function json(res, code, body) { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = ''; req.on('data', c => { s += c; if (s.length > 64 * 1024) { reject(new Error('too big')); req.destroy(); } });
    req.on('end', () => resolve(s)); req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/health') return json(res, 200, { ok: true, port: PORT });
    if (url.pathname === '/api/state') return json(res, 200, sched.state());
    if (url.pathname === '/api/bench' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req) || '{}');
      const rec = { at: new Date().toISOString(), gpu: String(b.gpu || '').slice(0, 200), samplesPerSec: Number(b.samplesPerSec) || 0,
        tilesPerSec: Number(b.tilesPerSec) || 0, width: b.width | 0, height: b.height | 0, tile: b.tile | 0,
        sppPerDispatch: b.sppPerDispatch | 0, seconds: Number(b.seconds) || 0, ua: String(b.ua || '').slice(0, 300) };
      fs.appendFileSync(BENCH, JSON.stringify(rec) + '\n');
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/bench') {
      const lines = fs.existsSync(BENCH) ? fs.readFileSync(BENCH, 'utf8').trim().split('\n').filter(Boolean) : [];
      return json(res, 200, lines.slice(-50).map(l => JSON.parse(l)));
    }
    const mf = url.pathname.match(/^\/frames\/(\d+)\.png$/);
    if (mf) {
      const f = frames.pngPath(Number(mf[1]));
      if (!fs.existsSync(f)) { res.writeHead(404); return res.end('no frame yet'); }
      const done = frames.done.has(Number(mf[1]));
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': done ? 'public, max-age=31536000, immutable' : 'no-store' });
      return fs.createReadStream(f).pipe(res);
    }
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.normalize(path.join(PUBLIC, p));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  } catch (e) { json(res, 500, { error: e.message }); }
});

// ---------- distribuidor por WebSocket ----------
const wss = new WebSocketServer({ server, maxPayload: 1 << 20 });
const conns = new Map(); // ws -> machine id
const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };

wss.on('connection', ws => {
  ws.on('message', (raw, isBinary) => {
    try {
      if (isBinary) {
        const mid = conns.get(ws); if (!mid) return;
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        const aid = buf.readUInt32LE(0), spp = buf.readUInt32LE(4);
        const data = new Float32Array(buf.buffer.slice(buf.byteOffset + 8, buf.byteOffset + buf.length));
        const r = sched.submit(mid, aid, data, spp);
        send(ws, { t: 'ack', aid, ...r });
        return;
      }
      const m = JSON.parse(raw.toString());
      if (m.t === 'hello') {
        let id = String(m.id || '').slice(0, 40) || Math.random().toString(36).slice(2, 10);
        for (const other of conns.values()) if (other === id) id = id + '-' + Math.random().toString(36).slice(2, 6);
        conns.set(ws, id);
        sched.join(id, m);
        send(ws, { t: 'welcome', id, film: sched.state().film });
      } else if (m.t === 'want') {
        const mid = conns.get(ws); if (!mid) return;
        const u = sched.request(mid);
        send(ws, u ? { t: 'unit', ...u, totalFrames: frames.frames } : { t: 'none' });
      } else if (m.t === 'rate') {
        const mid = conns.get(ws); const mm = sched.machines.get(mid); if (mm) mm.rate = Number(m.rate) || 0;
      }
    } catch (e) { sched.stats.errors.push(e.message); send(ws, { t: 'error', message: e.message }); }
  });
  ws.on('close', () => { const mid = conns.get(ws); if (mid) sched.leave(mid); conns.delete(ws); });
});

function broadcast() {
  const s = JSON.stringify({ t: 'state', ...sched.state() });
  for (const ws of conns.keys()) if (ws.readyState === 1) ws.send(s);
}
setInterval(broadcast, 1000);
setInterval(() => frames.save(), 20000);
sched.onFrameDone = f => console.log(`quadro ${f} terminado (${frames.done.size}/${frames.frames})`);

function shutdown() { frames.save(); process.exit(0); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);

server.listen(PORT, () => console.log(`filme: http://localhost:${PORT}  (data in ${DATA_DIR}; ${frames.frames} frames, ${frames.targetSpp} spp)`));
