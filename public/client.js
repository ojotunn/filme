// O lado do visitante: fala com o distribuidor por WebSocket, renderiza as unidades que recebe
// e devolve a soma. Também mostra o quadro atual (PNG do servidor) e o mapa de ladrilhos.
import { Renderer } from './render.js';

const $ = id => document.getElementById(id);
const errBox = $('err');
export function showErr(msg) { errBox.textContent += (errBox.textContent ? '\n' : '') + msg; errBox.classList.add('on'); state.error = msg; }
window.addEventListener('error', e => showErr('JS error: ' + (e.message || e)));
window.addEventListener('unhandledrejection', e => showErr('Promise error: ' + (e.reason && e.reason.message || e.reason)));

const q = new URLSearchParams(location.search);
const FILM_SAMPLES = 1440 * 1024 * 576 * 1024;

// Estado público (a prova headless lê window.__filme)
export const state = { supported: false, gpu: null, running: false, samples: 0, tiles: 0, rate: 0, tileRate: 0,
  elapsed: 0, spp: 0, reported: false, error: null, id: null, server: null, confirmed: 0, rejected: 0, inflight: 0, lastTile: null };
window.__filme = state;

// identidade da máquina: só uma conveniência por navegador (localStorage pode falhar; tudo em try)
function machineId() {
  if (q.get('id')) return q.get('id');
  try { let id = localStorage.getItem('filme.machine'); if (!id) { id = Math.random().toString(36).slice(2, 12); localStorage.setItem('filme.machine', id); } return id; }
  catch { return Math.random().toString(36).slice(2, 12); }
}

let renderer = null, ws = null, film = null, t0 = 0, hist = [], lastUi = 0, gpuMsTotal = 0, gpuSamples = 0;
const queue = [];   // unidades recebidas e ainda não renderizadas
let wantTimer = null, rendering = false;

async function init() {
  const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  if (mobile) { $('go').disabled = true; $('st').textContent = 'view only on phones'; $('note').textContent = 'Phones only watch. Computing runs on desktops and laptops.'; connect(false); return; }
  try {
    renderer = await Renderer.create(showErr);
    state.supported = true; state.gpu = renderer.gpu;
    $('gpu').textContent = renderer.gpu;
    $('st').textContent = 'ready';
  } catch (e) {
    $('gpu').textContent = 'no WebGPU'; $('st').textContent = 'view only (' + e.message + ')'; $('go').disabled = true;
  }
  connect(false);
  if (q.get('auto') === '1' && renderer) start();
}

function connect(compute) {
  if (ws && ws.readyState <= 1) { if (compute) sendHello(); return; }
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => sendHello();
  ws.onclose = () => { if (state.running) setTimeout(() => connect(true), 1500); };
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.t === 'welcome') { state.id = m.id; film = m.film; if (state.running) pump(); }
    else if (m.t === 'state') onState(m);
    else if (m.t === 'unit') { queue.push(m); drain(); }
    else if (m.t === 'none') { state.inflight = Math.max(0, state.inflight - 1); if (state.running) wantTimer = setTimeout(pump, 1500); }
    else if (m.t === 'ack') { if (m.status === 'confirmed') state.confirmed++; else if (m.status === 'rejected') { state.rejected++; showErr('a result was rejected by verification (' + (m.why || 'mismatch') + ')'); } }
    else if (m.t === 'error') showErr('server: ' + m.message);
  };
}
function sendHello() { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'hello', id: machineId(), name: q.get('name') || '', gpu: state.gpu || 'viewer', rate: state.rate })); }

// pede unidades até encher a fila local (mais placa, fila maior)
function pump() {
  if (!state.running || !ws || ws.readyState !== 1 || !film) return;
  clearTimeout(wantTimer);
  const K = Math.max(2, Math.min(8, Math.ceil(state.rate / (4096 * 256) * 0.5)));
  // cada 'want' vale um crédito; 'unit' e 'none' devolvem (unit ao terminar de renderizar)
  while (state.inflight < K) { ws.send(JSON.stringify({ t: 'want' })); state.inflight++; }
}

async function drain() {
  if (rendering) return; rendering = true;
  try {
    while (queue.length && state.running) {
      const u = queue.shift();
      const { data, gpuMs } = await renderer.renderUnit({ ...u, film });
      if (ws.readyState !== 1) { state.inflight--; continue; }
      const out = new ArrayBuffer(8 + data.byteLength);
      new Uint32Array(out, 0, 2).set([u.aid, u.spp]);
      new Float32Array(out, 8).set(data);
      ws.send(out);
      state.inflight--;
      state.tiles++; state.samples += u.spp * 4096; gpuMsTotal += gpuMs; gpuSamples += u.spp * 4096;
      state.lastTile = { frame: u.frame, tile: u.tile, spp: u.spp };
      drawTile(u, data);
      const now = performance.now();
      hist.push([now, state.samples, state.tiles]); while (hist.length > 2 && now - hist[0][0] > 5000) hist.shift();
      if (now - lastUi > 250) { lastUi = now; ui(now); }
      pump();
    }
  } catch (e) { showErr('render: ' + e.message); state.running = false; }
  finally { rendering = false; }
}

function onState(s) {
  state.server = s;
  $('machines').textContent = s.machines;
  $('framesDone').textContent = `${s.framesDone} / ${s.film.frames}`;
  $('frameNow').textContent = s.frame < 0 ? 'all done' : `#${s.frame}`;
  $('total').textContent = (s.samples / 1e9).toFixed(2) + ' G';
  const pct = s.film.frames ? (s.framesDone + (s.tiles.length ? s.tiles.reduce((a, b) => a + Math.min(b, s.film.targetSpp), 0) / (s.tiles.length * s.film.targetSpp) : 0)) / s.film.frames * 100 : 0;
  $('bar').style.width = pct.toFixed(2) + '%'; $('pct').textContent = pct.toFixed(2) + '%';
  $('verify').textContent = `${s.stats.agreed} agreed · ${s.stats.disputed} disputed · ${s.stats.rejected} rejected · ${s.stats.expired} expired`;
  $('top').innerHTML = s.top.slice(0, 10).map(m => `<tr><td>${esc(m.name)}${m.online ? '' : ' <i>(offline)</i>'}</td><td>${esc(m.gpu || '')}</td><td>${(m.samples / 1e9).toFixed(2)} G</td><td>${m.rep}</td></tr>`).join('');
  showFrame(s.frame, s.tiles, s.film);
}
function esc(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

// quadro atual: PNG do servidor desenhado no canvas #cv + mapa de ladrilhos por cima
const cv = $('cv'), cx = cv.getContext('2d'), tv = $('tiles'), tx = tv.getContext('2d');
let shownFrame = -1, lastImg = 0, viewFrame = null;
const img = new Image();
img.onload = () => { cv.width = img.width; cv.height = img.height; cx.drawImage(img, 0, 0); };
function showFrame(frame, tiles, f) {
  // filme terminado (frame = -1): mostra o último quadro pronto, sem mapa de ladrilhos
  const target = viewFrame ?? (frame >= 0 ? frame : f.frames - 1);
  if (target < 0) return;
  const now = Date.now();
  if (target !== shownFrame || now - lastImg > 2000) { shownFrame = target; lastImg = now; img.src = `/frames/${target}.png?v=${now}`; }
  tv.width = f.W; tv.height = f.H; tx.clearRect(0, 0, f.W, f.H);
  if (viewFrame !== null && viewFrame !== frame) return;
  // ladrilho ainda em andamento: só uma borda fina (o ruído do próprio quadro já mostra o progresso)
  const TX = f.W / f.TILE;
  tx.lineWidth = 1;
  for (let i = 0; i < tiles.length; i++) {
    const a = 1 - Math.min(1, tiles[i] / f.targetSpp);
    if (a <= 0) continue;
    tx.strokeStyle = `rgba(232,230,225,${(0.15 + a * 0.35).toFixed(2)})`;
    tx.strokeRect((i % TX) * f.TILE + 0.5, Math.floor(i / TX) * f.TILE + 0.5, f.TILE - 1, f.TILE - 1);
  }
  if (state.lastTile && state.lastTile.frame === frame) {
    tx.strokeStyle = '#e8e6e1'; tx.lineWidth = 3;
    tx.strokeRect((state.lastTile.tile % TX) * f.TILE + 1.5, Math.floor(state.lastTile.tile / TX) * f.TILE + 1.5, f.TILE - 3, f.TILE - 3);
  }
}
$('scrub').addEventListener('input', e => { viewFrame = Number(e.target.value); $('scrubLabel').textContent = '#' + viewFrame; if (state.server) showFrame(state.server.frame, state.server.tiles, state.server.film); });
$('live').addEventListener('click', () => { viewFrame = null; $('scrubLabel').textContent = 'live'; });
setInterval(() => { if (state.server) { $('scrub').max = Math.max(0, state.server.framesDone - (state.server.frame < 0 ? 1 : 0)); } }, 1000);

// prévia do meu último ladrilho (tonemap simples)
const mine = $('mine'), mc = mine.getContext('2d');
function drawTile(u, data) {
  const T = 64, id = mc.createImageData(T, T);
  for (let i = 0; i < T * T; i++) for (let c = 0; c < 3; c++) {
    const x = data[i * 3 + c] / u.spp; const a = Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));
    id.data[i * 4 + c] = Math.round(Math.pow(a, 1 / 2.2) * 255);
  }
  for (let i = 0; i < T * T; i++) id.data[i * 4 + 3] = 255;
  mc.putImageData(id, 0, 0);
  $('mineLabel').textContent = `frame #${u.frame} · tile ${u.tile} · ${u.spp} spp`;
}

function ui(now) {
  state.elapsed = (now - t0) / 1000;
  const h0 = hist[0]; const dt = (now - h0[0]) / 1000;
  state.rate = dt > 0.5 ? (state.samples - h0[1]) / dt : 0;
  state.tileRate = dt > 0.5 ? (state.tiles - h0[2]) / dt : 0;
  state.spp = state.tiles;
  const gpuRate = gpuMsTotal > 0 ? gpuSamples / (gpuMsTotal / 1000) : 0;
  $('rate').textContent = state.rate ? (state.rate / 1e6).toFixed(1) + ' M' + (gpuRate ? ` (GPU ${(gpuRate / 1e6).toFixed(0)} M)` : '') : '—';
  $('trate').textContent = state.tileRate ? state.tileRate.toFixed(1) : '—';
  $('spp').textContent = state.tiles + (state.confirmed ? ` · ${state.confirmed} confirmed` : '');
  $('el').textContent = state.elapsed.toFixed(0) + ' s';
  const r = state.rate || gpuRate;
  if (r) { const hours = FILM_SAMPLES / r / 3600; $('film').textContent = fmtHours(hours); $('film100').textContent = fmtHours(hours / 100); }
  if (ws && ws.readyState === 1 && state.rate) ws.send(JSON.stringify({ t: 'rate', rate: Math.round(gpuRate || state.rate) }));
}
function fmtHours(h) { return h > 48 ? (h / 24).toFixed(1) + ' days' : h >= 1 ? h.toFixed(1) + ' hours' : (h * 60).toFixed(0) + ' min'; }

const benchSeconds = Number(q.get('seconds') || 20);
async function report() {
  state.reported = true;
  $('st').textContent = 'computing · measurement sent';
  const gpuRate = gpuMsTotal > 0 ? gpuSamples / (gpuMsTotal / 1000) : state.rate;
  const body = { gpu: state.gpu, samplesPerSec: Math.round(gpuRate), tilesPerSec: +state.tileRate.toFixed(1), width: 1024, height: 576, tile: 64, sppPerDispatch: 64, seconds: +state.elapsed.toFixed(1), ua: navigator.userAgent, at: new Date().toISOString() };
  try { await fetch('/api/bench', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
  catch (e) { showErr('could not send measurement: ' + e.message); }
}

function start() {
  if (state.running) { state.running = false; queue.length = 0; $('go').textContent = 'Start computing'; $('st').textContent = 'stopped'; return; }
  state.running = true; t0 = performance.now(); lastUi = 0; hist = [[t0, state.samples, state.tiles]];
  $('go').textContent = 'Stop'; $('st').textContent = 'computing';
  connect(true); pump();
  setTimeout(() => { if (state.running && !state.reported) { ui(performance.now()); report(); } }, benchSeconds * 1000);
}
$('go').addEventListener('click', start);

init().catch(e => { showErr('init: ' + e.message); $('st').textContent = 'failed'; });
