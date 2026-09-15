// Prova da fase 3: o distribuidor de ponta a ponta, com um filme pequeno.
//   - três abas honestas num Chrome headless (três máquinas, sementes diferentes)
//   - um robô que manda LIXO pelo WebSocket
// Reprova se: o filme não termina; o lixo não é rejeitado; alguma aba honesta perde reputação;
// os PNGs finais não existem ou estão escuros; o estado não sobrevive a um restart.
//
//   node prova/prova_distribuidor.js
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import WebSocket from 'ws';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'prova', 'out-dist');
const PORT = 8442;
const FILM = { FILM_FRAMES: '3', TARGET_SPP: '256', WINDOW: '2', EXPIRE_S: '5', TOL: '0.35' };
const CHROMES = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'];
const dorme = ms => new Promise(r => setTimeout(r, ms));
const acharChrome = () => { for (const c of CHROMES) if (fs.existsSync(c)) return c; throw new Error('nao achei Chrome nem Edge'); };

async function subirServidor(limpar) {
  if (limpar) { fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true }); }
  const p = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], { env: { ...process.env, PORT: String(PORT), DATA_DIR: OUT, ...FILM }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', d => process.stdout.write('  [servidor] ' + d));
  p.stderr.on('data', d => process.stdout.write('  [servidor!] ' + d));
  for (let i = 0; i < 40; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.ok) return p; } catch {} await dorme(250); }
  p.kill(); throw new Error('o servidor local nao subiu');
}
const estado = async () => (await fetch(`http://127.0.0.1:${PORT}/api/state`)).json();

/** robô de lixo: aceita unidades e devolve números aleatórios */
function roboDeLixo() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const info = { unidades: 0, acks: {} , fechar: () => ws.close() };
  ws.on('open', () => { ws.send(JSON.stringify({ t: 'hello', id: 'garbage', name: 'garbage bot', gpu: 'fake', rate: 2e8 })); });
  ws.on('message', raw => {
    const m = JSON.parse(raw.toString());
    if (m.t === 'welcome') { ws.send(JSON.stringify({ t: 'want' })); ws.send(JSON.stringify({ t: 'want' })); }
    else if (m.t === 'unit') {
      info.unidades++;
      const out = Buffer.alloc(8 + 64 * 64 * 3 * 4);
      out.writeUInt32LE(m.aid, 0); out.writeUInt32LE(m.spp, 4);
      const f = new Float32Array(64 * 64 * 3); for (let i = 0; i < f.length; i++) f[i] = Math.random() * m.spp * 2;
      Buffer.from(f.buffer).copy(out, 8);
      setTimeout(() => { if (ws.readyState === 1) { ws.send(out); ws.send(JSON.stringify({ t: 'want' })); } }, 30);
    } else if (m.t === 'none') { setTimeout(() => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'want' })), 300); }
    else if (m.t === 'ack') { info.acks[m.status] = (info.acks[m.status] || 0) + 1; }
  });
  return info;
}

async function medirPng(page, arq) {
  const b64 = fs.readFileSync(arq).toString('base64');
  return page.evaluate(async b64 => {
    const img = new Image(); await new Promise(r => { img.onload = r; img.src = 'data:image/png;base64,' + b64; });
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let soma = 0, acesos = 0, n = c.width * c.height; const cores = new Set();
    for (let i = 0; i < d.length; i += 4) { const l = (d[i] + d[i + 1] + d[i + 2]) / 3; soma += l; if (l > 26) acesos++; if (l > 40) cores.add((d[i] >> 5) + ',' + (d[i + 1] >> 5) + ',' + (d[i + 2] >> 5)); }
    return { brilho: +(soma / n).toFixed(1), acesos: +(acesos / n).toFixed(3), cores: cores.size, w: c.width, h: c.height };
  }, b64);
}

async function main() {
  const chrome = acharChrome();
  let servidor = await subirServidor(true);
  const falhas = [];
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--headless=new', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
  const erros = [];
  try {
    const lixo = roboDeLixo();
    const pages = [];
    for (const n of ['A', 'B', 'C']) {
      const page = await browser.newPage();
      await page.setViewport({ width: 1400, height: 1000 });
      page.on('pageerror', e => erros.push(n + ': ' + e.message));
      page.on('console', m => { if (m.type() === 'error') erros.push(n + ' console: ' + m.text()); });
      await page.goto(`http://127.0.0.1:${PORT}/?auto=1&id=tab${n}&name=tab%20${n}&seconds=5`, { waitUntil: 'load' });
      pages.push(page);
    }
    // espera o filme terminar
    let s = null;
    for (let i = 0; i < 180; i++) { s = await estado(); if (s.framesDone >= 3) break; await dorme(500); }
    console.log('estado final:', JSON.stringify({ framesDone: s.framesDone, machines: s.machines, openUnits: s.openUnits, stats: s.stats }));
    console.log('máquinas:', s.top.map(m => `${m.name} rep=${m.rep} samples=${(m.samples / 1e6).toFixed(0)}M`).join(' | '));
    console.log('robô de lixo:', JSON.stringify({ unidades: lixo.unidades, acks: lixo.acks }));
    lixo.fechar();
    if (s.framesDone < 3) falhas.push(`filme nao terminou (${s.framesDone}/3)`);
    if (!(s.stats.rejected >= 1)) falhas.push('nenhum resultado de lixo foi rejeitado');
    const garbage = s.top.find(m => m.name === 'garbage bot');
    if (!garbage || garbage.rep >= 0) falhas.push('robo de lixo deveria ter reputacao negativa: ' + JSON.stringify(garbage));
    for (const n of ['A', 'B', 'C']) { const m = s.top.find(x => x.name === 'tab ' + n); if (!m) falhas.push(`aba ${n} nao apareceu`); else if (m.rep <= 0) falhas.push(`aba ${n} com reputacao ${m.rep} (deveria ser positiva)`); }
    if (!(s.stats.agreed >= 3)) falhas.push('poucos acordos entre abas honestas: ' + s.stats.agreed);
    const tela = await pages[0].evaluate(() => ({ ...window.__filme, server: undefined, err: document.getElementById('err').textContent }));
    console.log('aba A:', JSON.stringify({ gpu: tela.gpu, tiles: tela.tiles, confirmed: tela.confirmed, rejected: tela.rejected, rate: tela.rate, err: tela.err }));
    if (tela.err) falhas.push('erro na tela da aba A: ' + tela.err);
    if (tela.rejected > 0) falhas.push('aba honesta teve resultado rejeitado');
    if (erros.length) falhas.push('erros de js: ' + erros.slice(0, 5).join(' | '));
    for (let f = 0; f < 3; f++) {
      const arq = path.join(OUT, 'png', `${f}.png`);
      if (!fs.existsSync(arq)) { falhas.push(`png do quadro ${f} nao existe`); continue; }
      const m = await medirPng(pages[0], arq);
      console.log(`quadro ${f}:`, JSON.stringify(m));
      if (m.acesos < 0.5 || m.cores < 10 || m.w !== 1024) falhas.push(`quadro ${f} suspeito: ${JSON.stringify(m)}`);
    }
    await pages[0].screenshot({ path: path.join(OUT, 'pagina.png') });
    for (const p of pages) await p.close();

    // restart: o estado tem que sobreviver
    servidor.kill('SIGTERM'); await dorme(800);
    servidor = await subirServidor(false);
    const s2 = await estado();
    console.log('depois do restart: framesDone =', s2.framesDone);
    if (s2.framesDone !== 3) falhas.push('estado nao sobreviveu ao restart');
  } finally {
    await browser.close();
    servidor.kill();
  }
  if (falhas.length) { console.log('\nREPROVADO:\n - ' + falhas.join('\n - ')); process.exit(1); }
  console.log('\nAPROVADO. fotos em prova/out-dist/');
}
main().catch(e => { console.error('prova quebrou:', e); process.exit(2); });
