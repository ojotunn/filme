// Servidor mínimo da fase 2: serve o site e grava as medições que a página manda.
// DATA_DIR sobrescreve onde grava (as provas apontam para um descartável).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8440);
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const BENCH = path.join(DATA_DIR, 'bench.jsonl');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' };

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

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
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.normalize(path.join(PUBLIC, p));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => console.log(`filme: http://localhost:${PORT}  (data in ${DATA_DIR})`));
