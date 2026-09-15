// Renderizador de UNIDADES: um ladrilho de 64 x 64 com N passadas, e a soma RGB lida de volta da placa.
// Path tracer em WGSL (compute). O que o servidor recebe é exatamente o que sai daqui.
import { SCENE, cameraFor } from './scene.js';

const SHADER = /* wgsl */`
struct Params {
  size: vec4u,   // largura do quadro, altura, x do ladrilho, y do ladrilho (px)
  tile: vec4u,   // largura do ladrilho, altura, passadas neste despacho, semente
  round: vec4u,  // deslocamento da passada (para despachos em pedaços), 0, 0, 0
  camPos: vec4f,
  camFwd: vec4f,
  camRight: vec4f,
  camUp: vec4f,
  lens: vec4f,
};
struct Sphere { pr: vec4f, alb: vec4f, ext: vec4f };

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> accum: array<vec4f>;
@group(0) @binding(2) var<storage, read> spheres: array<Sphere>;

fn pcg(state: ptr<function, u32>) -> u32 {
  let old = *state;
  *state = old * 747796405u + 2891336453u;
  let word = ((old >> ((old >> 28u) + 4u)) ^ old) * 277803737u;
  return (word >> 22u) ^ word;
}
fn rnd(state: ptr<function, u32>) -> f32 { return f32(pcg(state)) / 4294967296.0; }
fn hashu(x0: u32) -> u32 { var h = x0; h ^= h >> 16u; h *= 0x7feb352du; h ^= h >> 15u; h *= 0x846ca68bu; h ^= h >> 16u; return h; }
fn onb(n: vec3f) -> mat3x3f {
  let a = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(n.x) > 0.9);
  let t = normalize(cross(a, n)); let b = cross(n, t);
  return mat3x3f(t, b, n);
}
fn cosineHemi(n: vec3f, rng: ptr<function, u32>) -> vec3f {
  let r1 = rnd(rng); let r2 = rnd(rng);
  let phi = 6.2831853 * r1; let r = sqrt(r2);
  return normalize(onb(n) * vec3f(r * cos(phi), r * sin(phi), sqrt(max(0.0, 1.0 - r2))));
}
fn randSphere(rng: ptr<function, u32>) -> vec3f {
  let z = rnd(rng) * 2.0 - 1.0; let a = rnd(rng) * 6.2831853; let r = sqrt(max(0.0, 1.0 - z * z));
  return vec3f(r * cos(a), r * sin(a), z);
}
fn sky(d: vec3f) -> vec3f { let t = clamp(d.y * 0.5 + 0.5, 0.0, 1.0); return mix(vec3f(0.55, 0.62, 0.75), vec3f(0.05, 0.08, 0.20), t) * 0.35; }
fn hitSphere(ro: vec3f, rd: vec3f, s: Sphere) -> f32 {
  let oc = ro - s.pr.xyz; let b = dot(oc, rd); let c = dot(oc, oc) - s.pr.w * s.pr.w;
  let disc = b * b - c; if (disc < 0.0) { return -1.0; }
  let sq = sqrt(disc); let t0 = -b - sq; if (t0 > 1e-3) { return t0; }
  let t1 = -b + sq; if (t1 > 1e-3) { return t1; }
  return -1.0;
}
fn trace(px: u32, py: u32, rng: ptr<function, u32>) -> vec3f {
  let jx = f32(px) + rnd(rng); let jy = f32(py) + rnd(rng);
  let u = (jx / f32(P.size.x)) * 2.0 - 1.0; let v = 1.0 - (jy / f32(P.size.y)) * 2.0;
  var ro = P.camPos.xyz;
  var rd = normalize(P.camFwd.xyz + u * P.lens.x * P.camRight.xyz + v * P.lens.y * P.camUp.xyz);
  var col = vec3f(0.0); var thr = vec3f(1.0);
  let n = arrayLength(&spheres);
  for (var b = 0u; b < 8u; b++) {
    var t = 1e30; var id = -1;
    if (rd.y < 0.0) { let tg = -ro.y / rd.y; if (tg > 1e-3 && tg < t) { t = tg; id = -2; } }
    for (var i = 0u; i < n; i++) { let ts = hitSphere(ro, rd, spheres[i]); if (ts > 0.0 && ts < t) { t = ts; id = i32(i); } }
    if (id == -1) { col += thr * sky(rd); break; }
    let p = ro + rd * t;
    var nrm = vec3f(0.0, 1.0, 0.0); var alb = vec3f(0.0);
    var mat = 0; var rough = 0.0; var ior = 1.5; var emis = 0.0;
    if (id == -2) {
      let cx = i32(floor(p.x * 0.5)); let cz = i32(floor(p.z * 0.5));
      alb = select(vec3f(0.22), vec3f(0.72), ((cx + cz) & 1) == 0);
    } else {
      let s = spheres[id]; nrm = normalize(p - s.pr.xyz);
      alb = s.alb.xyz; mat = i32(s.alb.w); emis = s.ext.x; rough = s.ext.y; ior = s.ext.z;
    }
    if (emis > 0.0) { col += thr * alb * emis; break; }
    let inside = dot(rd, nrm) > 0.0; let nn = select(nrm, -nrm, inside);
    if (mat == 0) { rd = cosineHemi(nn, rng); thr *= alb; ro = p + nn * 1e-3; }
    else if (mat == 1) { rd = normalize(reflect(rd, nn) + rough * randSphere(rng)); if (dot(rd, nn) <= 0.0) { break; } thr *= alb; ro = p + nn * 1e-3; }
    else {
      let eta = select(1.0 / ior, ior, inside); let cosi = clamp(-dot(rd, nn), 0.0, 1.0);
      let r0 = pow((1.0 - ior) / (1.0 + ior), 2.0); let fr = r0 + (1.0 - r0) * pow(1.0 - cosi, 5.0);
      let refr = refract(rd, nn, eta);
      if (all(refr == vec3f(0.0)) || rnd(rng) < fr) { rd = reflect(rd, nn); ro = p + nn * 1e-3; } else { rd = normalize(refr); ro = p - nn * 1e-3; }
      thr *= alb;
    }
    if (b > 2u) { let q = max(thr.x, max(thr.y, thr.z)); if (rnd(rng) > q) { break; } thr /= max(q, 1e-3); }
  }
  return min(col, vec3f(8.0));
}
@compute @workgroup_size(8, 8, 1)
fn cs(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= P.tile.x || gid.y >= P.tile.y) { return; }
  let px = P.size.z + gid.x; let py = P.size.w + gid.y;
  if (px >= P.size.x || py >= P.size.y) { return; }
  var rng = hashu(px * 1973u + py * 9277u + P.round.x * 26699u + P.tile.w * 7919u) | 1u;
  var sum = vec3f(0.0);
  for (var s = 0u; s < P.tile.z; s++) { sum += trace(px, py, &rng); }
  accum[gid.y * P.tile.x + gid.x] += vec4f(sum, f32(P.tile.z));
}
`;

const CHUNK = 64; // passadas por despacho (evita estourar o tempo limite da placa em máquinas fracas)

export class Renderer {
  static async create(onError) {
    if (!navigator.gpu) throw new Error('WebGPU not available');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('no GPU adapter');
    const info = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : {});
    const r = new Renderer();
    r.gpu = [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' · ') || 'unknown GPU';
    r.device = await adapter.requestDevice();
    r.device.addEventListener('uncapturederror', e => onError('GPU error: ' + (e.error && e.error.message || e.error)));
    r.device.lost.then(i => onError('GPU device lost: ' + i.message));
    const d = r.device; r.queue = d.queue;
    const mod = d.createShaderModule({ code: SHADER });
    const ci = await mod.getCompilationInfo();
    for (const m of ci.messages) if (m.type === 'error') onError(`WGSL ${m.lineNum}:${m.linePos} ${m.message}`);
    r.T = 64;
    r.tileBuf = d.createBuffer({ size: r.T * r.T * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    r.zeros = new Uint8Array(r.T * r.T * 16);
    r.paramBuf = d.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    r.sphereBuf = d.createBuffer({ size: SCENE.length * 48, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    r.queue.writeBuffer(r.sphereBuf, 0, new Float32Array(SCENE.flat()));
    r.readback = d.createBuffer({ size: r.T * r.T * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const bgl = d.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
    ]});
    r.pipe = d.createComputePipeline({ layout: d.createPipelineLayout({ bindGroupLayouts: [bgl] }), compute: { module: mod, entryPoint: 'cs' } });
    r.bg = d.createBindGroup({ layout: bgl, entries: [
      { binding: 0, resource: { buffer: r.paramBuf } }, { binding: 1, resource: { buffer: r.tileBuf } }, { binding: 2, resource: { buffer: r.sphereBuf } } ] });
    r.params = new ArrayBuffer(256);
    r.busy = false;
    return r;
  }

  /** renderiza uma unidade e devolve { data: Float32Array(64*64*3) com a SOMA das passadas, gpuMs } */
  async renderUnit(u) {
    if (this.busy) throw new Error('renderer busy');
    this.busy = true;
    try {
      const { W, H, TILE } = u.film; const T = this.T;
      const cam = cameraFor(u.frame, u.totalFrames, W, H);
      const ox = (u.tile % (W / TILE)) * TILE, oy = Math.floor(u.tile / (W / TILE)) * TILE;
      const ui = new Uint32Array(this.params, 0, 12), fl = new Float32Array(this.params, 48, 20);
      fl.set([...cam.pos, 0, ...cam.f, 0, ...cam.r, 0, ...cam.u, 0, cam.tx, cam.ty, 0, 0]);
      this.queue.writeBuffer(this.tileBuf, 0, this.zeros);
      const t0 = performance.now();
      for (let done = 0; done < u.spp; done += CHUNK) {
        const n = Math.min(CHUNK, u.spp - done);
        ui.set([W, H, ox, oy,  T, T, n, u.seed >>> 0,  done, 0, 0, 0]);
        this.queue.writeBuffer(this.paramBuf, 0, this.params);
        const enc = this.device.createCommandEncoder();
        const cp = enc.beginComputePass(); cp.setPipeline(this.pipe); cp.setBindGroup(0, this.bg); cp.dispatchWorkgroups(T / 8, T / 8); cp.end();
        this.queue.submit([enc.finish()]);
      }
      const enc = this.device.createCommandEncoder();
      enc.copyBufferToBuffer(this.tileBuf, 0, this.readback, 0, T * T * 16);
      this.queue.submit([enc.finish()]);
      await this.readback.mapAsync(GPUMapMode.READ);
      const gpuMs = performance.now() - t0;
      const v4 = new Float32Array(this.readback.getMappedRange());
      const data = new Float32Array(T * T * 3);
      for (let i = 0; i < T * T; i++) { data[i * 3] = v4[i * 4]; data[i * 3 + 1] = v4[i * 4 + 1]; data[i * 3 + 2] = v4[i * 4 + 2]; }
      this.readback.unmap();
      return { data, gpuMs };
    } finally { this.busy = false; }
  }
}
