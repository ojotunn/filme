// Cena de teste da fase 2/3 e o caminho da câmera por quadro. A cena de verdade é a fase 4.
// Material: 0 difuso, 1 metal, 2 vidro. Emissão > 0 = luz.
export const SCENE = [
  // centro.xyz, raio | cor.rgb, material | emissão, rugosidade, ior, 0
  [0.0, 1.0, 0.0, 1.0,   0.98, 0.98, 0.98, 2,   0, 0, 1.5, 0],      // vidro
  [-2.4, 1.0, -0.6, 1.0,  0.90, 0.75, 0.45, 1,   0, 0.08, 0, 0],    // metal dourado
  [2.4, 1.0, -0.6, 1.0,   0.75, 0.20, 0.18, 0,   0, 0, 0, 0],       // difuso vermelho
  [0.6, 0.35, 1.8, 0.35,  0.25, 0.55, 0.85, 0,   0, 0, 0, 0],       // difuso azul pequeno
  [-0.9, 0.3, 1.5, 0.3,   0.92, 0.92, 0.92, 1,   0, 0.35, 0, 0],    // metal fosco
  [0.0, 9.0, -3.0, 2.5,   1.0, 0.96, 0.9, 0,     14, 0, 0, 0],      // luz principal
  [-6.0, 3.5, 3.0, 0.8,   1.0, 0.55, 0.25, 0,    18, 0, 0, 0],      // luz quente lateral
];

function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(a) { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; }

/** câmera do quadro `frame` de `total`: meia volta em torno da cena, subindo devagar */
export function cameraFor(frame, total, W, H) {
  const k = total > 1 ? frame / (total - 1) : 0;
  const ang = -0.35 + k * Math.PI;                 // meia volta
  const R = 6.5, y = 1.6 + 1.2 * k;
  const pos = [Math.sin(ang) * R, y, Math.cos(ang) * R];
  const look = [0, 0.9, 0];
  const f = norm(sub(look, pos)); const r = norm(cross(f, [0, 1, 0])); const u = cross(r, f);
  const fovY = 38 * Math.PI / 180; const ty = Math.tan(fovY / 2); const tx = ty * W / H;
  return { pos, f, r, u, tx, ty };
}
