// Prova da fase 2: abre a página num Chrome headless (sem janela nenhuma), com WebGPU,
// e mede o que só o navegador vê. Reprova se:
//   1. houver erro de JavaScript ou de WGSL na tela (#err)
//   2. o WebGPU não vier (tenta a placa real; se não, o SwiftShader da Dawn)
//   3. o canvas ficar preto (conta pixel aceso na foto; não confia em "não deu erro")
//   4. a medição não chegar em prova/out/bench.jsonl
//   5. a página quebrar no tamanho de celular (tem que dizer "view only", sem erro)
//
//   node prova/prova_navegador.js
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'prova', 'out');
const PORT = 8441;
const SECONDS = Number(process.env.PROVA_SECONDS || 8);
const CHROMES = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'];
const dorme = ms => new Promise(r => setTimeout(r, ms));

function acharChrome() { for (const c of CHROMES) if (fs.existsSync(c)) return c; throw new Error('nao achei Chrome nem Edge'); }

async function subirServidor() {
  fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
  const p = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], { env: { ...process.env, PORT: String(PORT), DATA_DIR: OUT }, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.ok) return p; } catch {}
    await dorme(250);
  }
  p.kill(); throw new Error('o servidor local nao subiu');
}

/** fração de pixels acesos e cores distintas na foto do canvas */
async function medir(page, seletor, nome) {
  const cv = await page.$(seletor);
  const buf = await cv.screenshot({ encoding: 'binary' });
  fs.writeFileSync(path.join(OUT, nome), buf);
  return await page.evaluate(async (b64) => {
    const img = new Image();
    await new Promise(r => { img.onload = r; img.src = 'data:image/png;base64,' + b64; });
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let soma = 0, acesos = 0, n = c.width * c.height; const cores = new Set();
    for (let i = 0; i < d.length; i += 4) {
      const l = (d[i] + d[i + 1] + d[i + 2]) / 3; soma += l; if (l > 26) acesos++;
      if (l > 40) cores.add((d[i] >> 5) + ',' + (d[i + 1] >> 5) + ',' + (d[i + 2] >> 5));
    }
    return { brilho: +(soma / n).toFixed(1), acesos: +(acesos / n).toFixed(3), cores: cores.size, w: c.width, h: c.height };
  }, buf.toString('base64'));
}

async function tentar(chrome, flags, rotulo) {
  console.log(`\n== ${rotulo} ==`);
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', ...flags] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const erros = [];
  page.on('pageerror', e => erros.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') erros.push('console: ' + m.text()); });
  await page.goto(`http://127.0.0.1:${PORT}/?auto=1&seconds=${SECONDS}`, { waitUntil: 'load' });
  await dorme(SECONDS * 1000 + 3000);
  const st = await page.evaluate(() => ({ ...window.__filme, err: document.getElementById('err').textContent, status: document.getElementById('st').textContent }));
  const foto = st.supported ? await medir(page, '#cv', `desktop-${rotulo}.png`) : null;
  await page.screenshot({ path: path.join(OUT, `pagina-${rotulo}.png`) });
  await browser.close();
  return { st, foto, erros };
}

async function main() {
  const chrome = acharChrome();
  const servidor = await subirServidor();
  let falhas = [];
  try {
    // 1) placa real; 2) SwiftShader (CPU) se a placa real não aparecer no headless
    let r = await tentar(chrome, ['--headless=new', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-features=Vulkan'], 'gpu');
    if (!r.st.supported) {
      console.log('placa real nao veio no headless; tentando SwiftShader');
      r = await tentar(chrome, ['--headless=new', '--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--use-angle=swiftshader'], 'swiftshader');
    }
    const { st, foto, erros } = r;
    console.log('gpu:', st.gpu, '| status:', st.status);
    console.log('amostras/s:', st.rate && (st.rate / 1e6).toFixed(2) + ' M', '| ladrilhos/s:', st.tileRate && st.tileRate.toFixed(0), '| spp:', st.spp && st.spp.toFixed(2));
    console.log('foto do canvas:', foto);
    if (erros.length) console.log('erros do navegador:', erros);
    if (st.err) falhas.push('erro na tela: ' + st.err);
    if (erros.length) falhas.push('erros de js: ' + erros.join(' | '));
    if (!st.supported) falhas.push('WebGPU nao disponivel no headless (nem SwiftShader)');
    if (foto && (foto.acesos < 0.2 || foto.cores < 6)) falhas.push('canvas quase preto: ' + JSON.stringify(foto));
    if (!st.samples) falhas.push('nenhuma amostra calculada');
    const bench = path.join(OUT, 'bench.jsonl');
    if (!fs.existsSync(bench)) falhas.push('medicao nao chegou em bench.jsonl');
    else console.log('bench.jsonl:', fs.readFileSync(bench, 'utf8').trim());

    // celular: só assiste, sem erro
    const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--headless=new'] });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
    await page.setViewport({ width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 });
    const errosM = [];
    page.on('pageerror', e => errosM.push(e.message));
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
    await dorme(1500);
    const m = await page.evaluate(() => ({ status: document.getElementById('st').textContent, disabled: document.getElementById('go').disabled, err: document.getElementById('err').textContent, scrollW: document.documentElement.scrollWidth, innerW: innerWidth }));
    await page.screenshot({ path: path.join(OUT, 'celular.png') });
    await browser.close();
    console.log('celular:', m);
    if (!/view only/.test(m.status) || !m.disabled) falhas.push('celular deveria ser "view only" com botao desligado');
    if (m.err || errosM.length) falhas.push('erro no celular: ' + (m.err || errosM.join(' | ')));
    if (m.scrollW > m.innerW + 1) falhas.push('celular rola na horizontal');
  } finally {
    servidor.kill();
  }
  if (falhas.length) { console.log('\nREPROVADO:\n - ' + falhas.join('\n - ')); process.exit(1); }
  console.log('\nAPROVADO. fotos em prova/out/');
}

main().catch(e => { console.error('prova quebrou:', e); process.exit(2); });
