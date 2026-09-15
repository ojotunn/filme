// Escalonador: quem recebe qual unidade, e o que fazer com o resultado (ver SPEC, "Verificação").
// Unidade = (quadro, ladrilho). Cada atribuição tem semente própria; os resultados de máquinas
// diferentes são amostras independentes da mesma imagem, então TODOS entram no acumulador na
// hora, e a comparação por blocos decide depois se algum era lixo (e o subtrai).
import { Frames } from './frames.js';

let seq = 1;
const now = () => Date.now();

/** erro relativo médio entre as médias de blocos 8x8 de dois resultados (soma RGB / passadas) */
export function compareTiles(a, na, b, nb, T = 64) {
  const B = 8, nb8 = T / B; let total = 0, blocks = 0;
  for (let by = 0; by < nb8; by++) for (let bx = 0; bx < nb8; bx++) {
    let sa = 0, sb = 0;
    for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) {
      const i = ((by * B + y) * T + (bx * B + x)) * 3;
      sa += a[i] + a[i + 1] + a[i + 2]; sb += b[i] + b[i + 1] + b[i + 2];
    }
    const ma = sa / na / (B * B * 3), mb = sb / nb / (B * B * 3);
    total += Math.abs(ma - mb) / ((ma + mb) / 2 + 0.02); blocks++;
  }
  return total / blocks;
}

export class Scheduler {
  constructor(frames, opts = {}) {
    this.frames = frames;
    this.window = opts.window ?? 2;
    this.tol = opts.tol ?? 0.35;
    this.expireMs = (opts.expireS ?? 60) * 1000;
    this.assignTimeoutMs = (opts.assignTimeoutS ?? 120) * 1000;
    this.maxInflight = opts.maxInflight ?? 8;
    this.minSpp = 32; this.maxSpp = 1024;
    this.machines = new Map();   // id -> { id, name, gpu, rate, rep, inflight:Set<aid>, samples, agreed, rejected }
    this.units = new Map();      // uid -> { uid, frame, tile, results:[], assigned:Map<aid,{mid,spp,t}>, needed, disputed, created }
    this.byTile = new Map();     // "frame:tile" -> Set<uid>
    this.stats = { agreed: 0, disputed: 0, rejected: 0, expired: 0, inconclusive: 0, unitsClosed: 0, agreeErrMax: 0, agreeErrMean: 0, disputeErrMin: null, errors: [] };
    this.onFrameDone = () => {};
    this.onTile = () => {};
  }

  // ---------- máquinas ----------
  join(id, info) {
    let m = this.machines.get(id);
    if (!m) { m = { id, rep: 0, samples: 0, agreed: 0, rejected: 0, inflight: new Set() }; this.machines.set(id, m); }
    Object.assign(m, { name: String(info.name || '').slice(0, 40), gpu: String(info.gpu || '').slice(0, 120), rate: Number(info.rate) || 0, online: true, seen: now() });
    return m;
  }
  leave(id) {
    const m = this.machines.get(id); if (!m) return;
    m.online = false;
    for (const aid of m.inflight) this.unassign(aid);
    m.inflight.clear();
  }

  // ---------- fila ----------
  firstOpenFrame() { for (let f = 0; f < this.frames.frames; f++) if (!this.frames.done.has(f)) return f; return -1; }

  inflightSpp(frame, tile) {
    let s = 0;
    for (const uid of this.byTile.get(`${frame}:${tile}`) || []) { const u = this.units.get(uid); for (const a of u.assigned.values()) s += a.spp; }
    return s;
  }

  sppFor(m, deficit) {
    // ~0,3 s de placa por unidade; múltiplo de 16 entre min e max, limitado ao déficit
    const want = m.rate > 0 ? Math.round(m.rate * 0.3 / 4096 / 16) * 16 : 64;
    return Math.max(16, Math.min(this.maxSpp, Math.max(this.minSpp, want), Math.max(16, Math.ceil(deficit / 16) * 16)));
  }

  /** próxima unidade para a máquina, ou null */
  request(mid) {
    const m = this.machines.get(mid);
    if (!m || m.rep < -3) return null;
    if (m.inflight.size >= this.maxInflight) return null;
    this.reap();
    const first = this.firstOpenFrame();
    if (first < 0) return null;
    const last = Math.min(this.frames.frames - 1, first + this.window - 1);

    // 1) unidade esperando verificação (tem resultado, falta gente), da qual esta máquina não participou
    let best = null;
    for (const u of this.units.values()) {
      if (u.results.length === 0 || u.results.length + u.assigned.size >= u.needed) continue;
      if (u.results.some(r => r.mid === mid) || [...u.assigned.values()].some(a => a.mid === mid)) continue;
      if (!best || u.frame < best.frame || (u.frame === best.frame && u.created < best.created)) best = u;
    }
    if (best) return this.assign(best, m, this.sppFor(m, best.results[0].spp));

    // 2) ladrilho com maior déficit dentro da janela (quadro mais antigo primeiro)
    for (let f = first; f <= last; f++) {
      if (this.frames.done.has(f)) continue;
      this.frames.ensure(f);
      let bt = -1, bd = 0;
      for (let t = 0; t < this.frames.NT; t++) {
        const d = this.frames.targetSpp - this.frames.spp(f, t) - this.inflightSpp(f, t);
        if (d > bd) { bd = d; bt = t; }
      }
      if (bt < 0) continue;
      const u = { uid: seq++, frame: f, tile: bt, results: [], assigned: new Map(), needed: 2, disputed: false, created: now() };
      this.units.set(u.uid, u);
      const key = `${f}:${bt}`; if (!this.byTile.has(key)) this.byTile.set(key, new Set()); this.byTile.get(key).add(u.uid);
      return this.assign(u, m, this.sppFor(m, bd));
    }

    // 3) nada dentro da janela: unidades sozinhas há muito tempo expiram sem verificação
    if (this.expireLonely()) return this.request(mid);
    return null;
  }

  assign(u, m, spp) {
    const aid = seq++;
    const seed = (Math.imul(aid, 2654435761) ^ Math.imul(u.frame + 1, 40503) ^ (u.tile * 97)) >>> 0 || 1;
    u.assigned.set(aid, { mid: m.id, spp, t: now() });
    m.inflight.add(aid);
    return { aid, uid: u.uid, frame: u.frame, tile: u.tile, spp, seed };
  }

  unassign(aid) {
    for (const u of this.units.values()) {
      if (!u.assigned.has(aid)) continue;
      u.assigned.delete(aid);
      if (u.results.length === 0 && u.assigned.size === 0) this.closeUnit(u);
      return;
    }
  }

  /** atribuições velhas demais voltam para a fila */
  reap() {
    const t = now();
    for (const u of this.units.values()) for (const [aid, a] of u.assigned) if (t - a.t > this.assignTimeoutMs) {
      u.assigned.delete(aid); const m = this.machines.get(a.mid); if (m) m.inflight.delete(aid);
      if (u.results.length === 0 && u.assigned.size === 0) this.closeUnit(u);
    }
  }

  expireLonely() {
    const t = now(); let n = 0;
    for (const u of [...this.units.values()]) {
      if (u.results.length >= 1 && u.assigned.size === 0 && t - u.created > this.expireMs) { this.stats.expired++; this.closeUnit(u); n++; }
    }
    return n > 0;
  }

  // ---------- resultados ----------
  /** data: Float32Array(64*64*3) com a SOMA das passadas */
  submit(mid, aid, data, spp) {
    const m = this.machines.get(mid); if (!m) return { status: 'unknown machine' };
    m.inflight.delete(aid);
    let u = null; for (const x of this.units.values()) if (x.assigned.has(aid)) { u = x; break; }
    if (!u) return { status: 'stale' };
    const a = u.assigned.get(aid); u.assigned.delete(aid);
    if (spp !== a.spp || data.length !== this.frames.TILE * this.frames.TILE * 3) { m.rep -= 1; return { status: 'rejected', why: 'wrong size' }; }
    for (let i = 0; i < data.length; i++) if (!(data[i] >= 0) || data[i] > 1e6) { m.rep -= 2; m.rejected++; this.stats.rejected++; return { status: 'rejected', why: 'bad numbers' }; }

    // entra na hora (provisório); a verificação vem atrás
    this.frames.merge(u.frame, u.tile, data, spp, +1);
    m.samples += spp * this.frames.TILE * this.frames.TILE;
    u.results.push({ aid, mid, spp, data, ok: null });
    this.onTile(u.frame, u.tile);

    let status = 'pending';
    if (u.results.length === 2) {
      const [r0, r1] = u.results;
      const err = compareTiles(r0.data, r0.spp, r1.data, r1.spp, this.frames.TILE);
      u.lastErr = err;
      if (err <= this.tol) { this.noteAgree(err); this.agree(r0, r1); status = 'confirmed'; this.closeUnit(u); }
      else { this.stats.disputeErrMin = this.stats.disputeErrMin === null ? err : Math.min(this.stats.disputeErrMin, err); u.disputed = true; u.needed = 3; this.stats.disputed++; status = 'disputed'; }
    } else if (u.results.length === 3) {
      const [r0, r1, r2] = u.results;
      const e01 = compareTiles(r0.data, r0.spp, r1.data, r1.spp), e02 = compareTiles(r0.data, r0.spp, r2.data, r2.spp), e12 = compareTiles(r1.data, r1.spp, r2.data, r2.spp);
      const pairs = [[e01, r0, r1, r2], [e02, r0, r2, r1], [e12, r1, r2, r0]].sort((x, y) => x[0] - y[0]);
      const [e, p, q, odd] = pairs[0];
      if (e <= this.tol) { this.noteAgree(e); this.agree(p, q); this.reject(u, odd); status = odd.mid === mid ? 'rejected' : 'confirmed'; }
      else { this.stats.inconclusive++; status = 'inconclusive'; }
      this.closeUnit(u);
    }
    this.afterMerge(u.frame);
    return { status, err: u.lastErr };
  }

  /** distribuição do erro entre resultados honestos: serve para calibrar TOL */
  noteAgree(err) {
    const n = this.stats.agreed;
    this.stats.agreeErrMean = +((this.stats.agreeErrMean * n + err) / (n + 1)).toFixed(4);
    this.stats.agreeErrMax = +Math.max(this.stats.agreeErrMax, err).toFixed(4);
  }
  agree(a, b) {
    for (const r of [a, b]) { r.ok = true; const m = this.machines.get(r.mid); if (m) { m.rep += 1; m.agreed++; } }
    this.stats.agreed++;
  }
  reject(u, r) {
    r.ok = false;
    this.frames.merge(u.frame, u.tile, r.data, r.spp, -1);
    const m = this.machines.get(r.mid); if (m) { m.rep -= 2; m.rejected++; m.samples = Math.max(0, m.samples - r.spp * 4096); }
    this.stats.rejected++;
    this.onTile(u.frame, u.tile);
  }

  closeUnit(u) {
    this.units.delete(u.uid);
    const key = `${u.frame}:${u.tile}`; const s = this.byTile.get(key); if (s) { s.delete(u.uid); if (!s.size) this.byTile.delete(key); }
    this.stats.unitsClosed++;
    for (const r of u.results) r.data = null;
  }

  openUnitsOf(frame) { let n = 0; for (const u of this.units.values()) if (u.frame === frame) n++; return n; }

  afterMerge(frame) {
    if (this.frames.done.has(frame)) return;
    if (this.frames.frameFull(frame) && this.openUnitsOf(frame) === 0) { this.frames.finalize(frame); this.onFrameDone(frame); }
    else this.frames.renderPNG(frame);
  }

  // ---------- estado para o site ----------
  state() {
    const first = this.firstOpenFrame();
    const tiles = first >= 0 && this.frames.tileSpp.has(first) ? Array.from(this.frames.tileSpp.get(first)) : [];
    const machines = [...this.machines.values()].filter(m => m.online);
    return {
      film: { frames: this.frames.frames, W: this.frames.W, H: this.frames.H, TILE: this.frames.TILE, targetSpp: this.frames.targetSpp },
      framesDone: this.frames.done.size, frame: first, tiles,
      machines: machines.length, openUnits: this.units.size, samples: this.frames.totalSamples(),
      stats: { ...this.stats, errors: undefined },
      top: [...this.machines.values()].sort((a, b) => b.samples - a.samples).slice(0, 20).map(m => ({ name: m.name || `machine ${m.id.slice(0, 6)}`, gpu: m.gpu, samples: m.samples, rep: m.rep, online: !!m.online })),
    };
  }
}

export { Frames };
