// Acumuladores dos quadros: soma RGB em float32 por pixel + passadas por ladrilho.
// Quadro aberto fica na memória e vai para o disco a cada `saveEvery`; quadro terminado
// vira PNG final e sai da memória. O PNG visível de um quadro aberto é regerado com
// intervalo mínimo, para o site mostrar o ruído sumindo.
import fs from 'node:fs';
import path from 'node:path';
import { encodePNG } from './png.js';

function aces(x) { return Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14))); }

export class Frames {
  constructor({ W, H, TILE, frames, targetSpp, dataDir, exposure = 1.0, pngEvery = 2000 }) {
    Object.assign(this, { W, H, TILE, frames, targetSpp, dataDir, exposure, pngEvery });
    this.TX = W / TILE; this.TY = H / TILE; this.NT = this.TX * this.TY;
    this.acc = new Map();      // quadro -> Float32Array(W*H*3)
    this.tileSpp = new Map();  // quadro -> Uint32Array(NT)
    this.done = new Set();
    this.dirty = new Set();
    this.lastPng = new Map();
    this.pngTimers = new Map();  // regeração agendada para o fim do intervalo (o último merge nunca fica sem PNG)
    this.pngDir = path.join(dataDir, 'png'); this.accDir = path.join(dataDir, 'acc');
    fs.mkdirSync(this.pngDir, { recursive: true }); fs.mkdirSync(this.accDir, { recursive: true });
    this.stateFile = path.join(dataDir, 'frames.json');
    this.load();
  }

  load() {
    if (!fs.existsSync(this.stateFile)) return;
    try {
      const s = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      for (const f of s.done || []) this.done.add(f);
      for (const [f, arr] of Object.entries(s.tileSpp || {})) {
        const frame = Number(f);
        const accFile = path.join(this.accDir, `${frame}.f32`);
        if (!fs.existsSync(accFile)) continue;
        const buf = fs.readFileSync(accFile);
        this.acc.set(frame, new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
        this.tileSpp.set(frame, Uint32Array.from(arr));
      }
    } catch (e) { console.error('frames: estado ilegivel, comecando do zero:', e.message); }
  }

  save() {
    for (const f of this.dirty) {
      const a = this.acc.get(f);
      if (a) fs.writeFileSync(path.join(this.accDir, `${f}.f32`), Buffer.from(a.buffer, a.byteOffset, a.byteLength));
    }
    this.dirty.clear();
    const tileSpp = {};
    for (const [f, t] of this.tileSpp) tileSpp[f] = Array.from(t);
    fs.writeFileSync(this.stateFile, JSON.stringify({ done: Array.from(this.done), tileSpp }));
  }

  ensure(frame) {
    if (!this.acc.has(frame)) { this.acc.set(frame, new Float32Array(this.W * this.H * 3)); this.tileSpp.set(frame, new Uint32Array(this.NT)); }
  }

  spp(frame, tile) { const t = this.tileSpp.get(frame); return t ? t[tile] : (this.done.has(frame) ? this.targetSpp : 0); }

  /** soma (sinal +1) ou subtrai (sinal -1) o resultado de um ladrilho */
  merge(frame, tile, data, spp, sign = 1) {
    this.ensure(frame);
    const a = this.acc.get(frame), T = this.TILE, W = this.W;
    const ox = (tile % this.TX) * T, oy = Math.floor(tile / this.TX) * T;
    for (let y = 0; y < T; y++) {
      const row = ((oy + y) * W + ox) * 3, src = y * T * 3;
      for (let i = 0; i < T * 3; i++) a[row + i] += sign * data[src + i];
    }
    const t = this.tileSpp.get(frame);
    t[tile] = Math.max(0, t[tile] + sign * spp);
    this.dirty.add(frame);
  }

  tileFull(frame, tile) { return this.spp(frame, tile) >= this.targetSpp; }
  frameFull(frame) { const t = this.tileSpp.get(frame); if (!t) return false; for (let i = 0; i < this.NT; i++) if (t[i] < this.targetSpp) return false; return true; }

  /** média tonemapada -> PNG; regera no máximo a cada pngEvery ms, ou sempre se `force` */
  renderPNG(frame, force = false) {
    const a = this.acc.get(frame); if (!a) return false;
    const now = Date.now();
    const wait = this.pngEvery - (now - (this.lastPng.get(frame) || 0));
    if (!force && wait > 0) {
      if (!this.pngTimers.has(frame)) this.pngTimers.set(frame, setTimeout(() => { this.pngTimers.delete(frame); this.renderPNG(frame, true); }, wait + 10));
      return false;
    }
    if (this.pngTimers.has(frame)) { clearTimeout(this.pngTimers.get(frame)); this.pngTimers.delete(frame); }
    this.lastPng.set(frame, now);
    const { W, H, TILE, TX } = this;
    const rgb = new Uint8Array(W * H * 3);
    const t = this.tileSpp.get(frame);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const n = t[Math.floor(y / TILE) * TX + Math.floor(x / TILE)];
      const i = (y * W + x) * 3;
      if (n === 0) continue;
      for (let c = 0; c < 3; c++) rgb[i + c] = Math.round(Math.pow(aces(a[i + c] / n * this.exposure), 1 / 2.2) * 255);
    }
    fs.writeFileSync(this.pngPath(frame), encodePNG(W, H, rgb));
    return true;
  }

  pngPath(frame) { return path.join(this.pngDir, `${frame}.png`); }

  /** quadro terminado: PNG final, acumulador para o disco (uma última vez) e fora da memória */
  finalize(frame) {
    this.renderPNG(frame, true);
    const a = this.acc.get(frame);
    if (a) fs.writeFileSync(path.join(this.accDir, `${frame}.f32`), Buffer.from(a.buffer, a.byteOffset, a.byteLength));
    this.done.add(frame);
    if (this.pngTimers.has(frame)) { clearTimeout(this.pngTimers.get(frame)); this.pngTimers.delete(frame); }
    this.acc.delete(frame); this.tileSpp.delete(frame); this.dirty.delete(frame); this.lastPng.delete(frame);
    this.save();
  }

  /** passadas somadas em todos os quadros (para o contador do site) */
  totalSamples() {
    let s = this.done.size * this.NT * this.targetSpp;
    for (const t of this.tileSpp.values()) for (let i = 0; i < this.NT; i++) s += Math.min(t[i], this.targetSpp * 2);
    return s * this.TILE * this.TILE;
  }
}
