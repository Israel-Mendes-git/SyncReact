// Teste de ponta a ponta: Chromium sem janela + extensão + duas abas do YouTube na mesma sala.
// Uso: node tools/test-sync.mjs        (variável CHROMIUM aponta outro executável, se precisar)
import { chromium } from 'playwright-core';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tools', 'out');
const EXE = process.env.CHROMIUM ||
  path.join(homedir(), 'AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe');
const VIDEO_A = 'aqz-KE-bpKQ'; // Big Buck Bunny (Blender, CC)
const VIDEO_B = 'eRsGyueVLvQ'; // Sintel (Blender, CC)

mkdirSync(OUT, { recursive: true });
const profile = path.join(tmpdir(), 'syncreact-test-' + Date.now());
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

let pagesForDebug = [];
async function check(name, ok, detail) {
  results.push({ name, ok, detail });
  log(ok ? 'PASSOU' : 'FALHOU', '-', name, detail ? '· ' + detail : '');
  if (!ok && pagesForDebug.length) {
    const dumps = {};
    for (const [label, page] of pagesForDebug) {
      dumps[label] = await page.evaluate(() => {
        window.dispatchEvent(new Event('syncreact-debug'));
        return JSON.parse(document.documentElement.dataset.syncreact || 'null');
      }).catch((e) => String(e));
    }
    const file = path.join(OUT, 'debug-' + results.length + '.json');
    writeFileSync(file, JSON.stringify(dumps, null, 1));
    log('   registro salvo em', path.relative(ROOT, file));
  }
}

const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: EXE,
  headless: true,
  viewport: { width: 1280, height: 720 },
  args: [
    `--disable-extensions-except=${ROOT}`,
    `--load-extension=${ROOT}`,
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-background-media-suspend',
    '--lang=pt-BR',
  ],
});

try {
  let sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 15000 }));
  const extId = new URL(sw.url()).host;
  log('extensão carregada', extId);

  async function openVideo(id) {
    const page = await ctx.newPage();
    await page.goto('https://www.youtube.com/watch?v=' + id, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('video.html5-main-video', { timeout: 30000 });
    return page;
  }

  const sample = (page) => page.evaluate(() => {
    const v = document.querySelector('video.html5-main-video');
    const p = document.querySelector('#movie_player');
    if (!v) return { pos: 0, t: Date.now(), paused: true, rate: 1, ready: 0, ad: false, vid: null, overlay: '' };
    return {
      pos: v.currentTime, t: performance.timeOrigin + performance.now(), paused: v.paused,
      rate: v.playbackRate, ready: v.readyState, ad: p ? p.classList.contains('ad-showing') : false,
      vid: new URLSearchParams(location.search).get('v'),
      overlay: (document.querySelector('.syncreact-overlay') || {}).innerText || '',
    };
  });

  async function diffMs(pa, pb) {
    const [a, b] = await Promise.all([sample(pa), sample(pb)]);
    const T = Math.max(a.t, b.t);
    const at = (s) => s.pos + (s.paused ? 0 : ((T - s.t) / 1000) * s.rate);
    return { ms: Math.round((at(a) - at(b)) * 1000), a, b };
  }

  async function waitNoAd(page, label) {
    for (let i = 0; i < 120; i++) {
      const s = await sample(page);
      if (!s.ad && s.ready >= 2) return true;
      if (s.ad) {
        const skip = await page.$('.ytp-skip-ad-button, .ytp-ad-skip-button-modern');
        if (skip) await skip.click().catch(() => {});
      }
      if (i % 10 === 0) log(label, 'esperando anúncio/carregamento…', JSON.stringify({ ad: s.ad, ready: s.ready }));
      await sleep(1000);
    }
    return false;
  }

  const pageA = await openVideo(VIDEO_A);
  // B em outra janela, para as duas abas ficarem visíveis como em dois PCs
  const pageBPromise = ctx.waitForEvent('page');
  await sw.evaluate((url) => chrome.windows.create({ url, focused: false, width: 1280, height: 720 }),
    'https://www.youtube.com/watch?v=' + VIDEO_A);
  const pageB = await pageBPromise;
  await pageB.waitForSelector('video.html5-main-video', { timeout: 30000 });
  log('visibilidade', await pageA.evaluate(() => document.visibilityState), await pageB.evaluate(() => document.visibilityState));
  pagesForDebug = [['A', pageA], ['B', pageB]];
  await Promise.all([waitNoAd(pageA, 'A'), waitNoAd(pageB, 'B')]);

  // deixa as duas abas em pontos diferentes, pausadas, antes de entrar na sala
  // pela API do player do YouTube, como a pessoa faria pela interface
  await pageA.evaluate(() => { const p = document.querySelector('#movie_player'); p.pauseVideo(); p.seekTo(30, true); });
  await pageB.evaluate(() => { const p = document.querySelector('#movie_player'); p.pauseVideo(); p.seekTo(95, true); });
  await sleep(2000);

  const tabs = await sw.evaluate(() => chrome.tabs.query({ url: 'https://www.youtube.com/*' }).then((t) => t.map((x) => x.id)));
  const [tabA, tabB] = tabs;
  log('abas', tabs);
  await sw.evaluate(() => chrome.storage.local.set({ name: 'Teste' }));
  await sw.evaluate((id) => self.syncreact.join(id, 'TESTE1'), tabA);
  await sleep(2500); // A fica sozinha e inaugura a sala
  await sw.evaluate((id) => self.syncreact.join(id, 'TESTE1'), tabB);
  await sleep(2500);

  // espera a condição valer em `stable` amostras seguidas; devolve quanto tempo levou
  async function settle(cond, { timeout = 10000, stable = 3 } = {}) {
    const t0 = Date.now();
    let streak = 0;
    let last;
    while (Date.now() - t0 < timeout) {
      last = await diffMs(pageA, pageB);
      streak = cond(last) ? streak + 1 : 0;
      if (streak >= stable) return { ok: true, ms: Date.now() - t0, last };
      await sleep(250);
    }
    return { ok: false, ms: Date.now() - t0, last };
  }
  const synced = (d) => !d.a.paused && !d.b.paused && !d.a.ad && !d.b.ad && Math.abs(d.ms) < 60;
  const bothPaused = (d) => d.a.paused && d.b.paused && Math.abs(d.ms) < 150;
  const fmt = (r) => `em ${(r.ms / 1000).toFixed(1)} s · A=${r.last.a.pos.toFixed(2)} B=${r.last.b.pos.toFixed(2)} ` +
    `pausados=${r.last.a.paused}/${r.last.b.paused} dif=${r.last.ms} ms`;
  async function steady(seconds) {
    const series = [];
    for (let i = 0; i < seconds * 2; i++) { series.push((await diffMs(pageA, pageB)).ms); await sleep(500); }
    return series;
  }

  let r = await settle(bothPaused, { timeout: 6000 });
  await check('ao entrar, B vai para o ponto de A e fica pausado', r.ok && Math.abs(r.last.a.pos - 30) < 0.5, fmt(r));

  // play pela tecla K em A (gesto real)
  await pageA.locator('#movie_player').focus();
  await pageA.keyboard.press('k');
  r = await settle(synced, { timeout: 12000 });
  await check('play em A: os dois tocando juntos', r.ok, fmt(r));
  let series = await steady(5);
  await check('tocando, diferença fica abaixo de 60 ms', series.every((x) => Math.abs(x) < 60), `ms: ${series.join(', ')}`);
  await pageA.screenshot({ path: path.join(OUT, 'a-tocando.png') });

  // seek em B: tecla J do YouTube volta 10 s (gesto real). Pulo longo não dá para testar aqui:
  // no Chromium sem janela o YouTube não carrega depois de um pulo longo, nem sem a extensão.
  const beforeSeek = (await sample(pageB)).pos;
  await pageB.locator('#movie_player').focus();
  await pageB.keyboard.press('j');
  const tSeek = Date.now();
  r = await settle((d) => synced(d) && d.a.pos < beforeSeek + (Date.now() - tSeek) / 1000 - 5, { timeout: 12000 });
  await check('seek em B leva A junto', r.ok, fmt(r));

  // deriva pequena: B adiantado 0,4 s sem ser ação da pessoa → corrigido sem pular
  await pageB.evaluate(() => {
    const v = document.querySelector('video.html5-main-video');
    document.querySelector('#movie_player').seekTo(v.currentTime + 0.4, true);
  });
  await sleep(600);
  const d0 = (await diffMs(pageA, pageB)).ms;
  r = await settle(synced, { timeout: 12000 });
  await check('deriva de 0,4 s é corrigida', r.ok, `logo depois ${d0} ms; ` + fmt(r));

  // pause pela tecla K em B
  await pageB.locator('#movie_player').focus();
  await pageB.keyboard.press('k');
  r = await settle(bothPaused, { timeout: 5000 });
  await check('pause em B pausa A', r.ok, fmt(r));

  // play com contagem a partir do popup de A
  await sw.evaluate((id) => self.syncreact.countdown(id), tabA);
  await sleep(1200);
  await pageB.screenshot({ path: path.join(OUT, 'b-contagem.png') });
  const mid = await diffMs(pageA, pageB);
  await check('contagem: os dois esperam parados', mid.a.paused && mid.b.paused, `overlay B="${mid.b.overlay.split('\n').join(' ')}"`);
  r = await settle(synced, { timeout: 10000 });
  await check('contagem: os dois começam juntos', r.ok, fmt(r));

  // anúncio simulado em B: A espera, depois os dois voltam do mesmo ponto
  await pageB.evaluate(() => document.querySelector('#movie_player').classList.add('ad-showing'));
  r = await settle((d) => d.a.paused, { timeout: 4000 });
  const held = await sample(pageA);
  await pageA.screenshot({ path: path.join(OUT, 'a-esperando-anuncio.png') });
  await sleep(2000);
  const held2 = await sample(pageA);
  await check('anúncio em B: A espera parado', r.ok && held2.paused && Math.abs(held2.pos - held.pos) < 0.05,
    `overlay A="${held.overlay}"`);
  await pageB.evaluate(() => document.querySelector('#movie_player').classList.remove('ad-showing'));
  r = await settle(synced, { timeout: 15000 });
  await check('fim do anúncio: os dois retomam juntos', r.ok && Math.abs(r.last.a.pos - held.pos) < 15, fmt(r));

  // troca de vídeo em A (abrindo a URL): B segue
  await pageA.goto('https://www.youtube.com/watch?v=' + VIDEO_B, { waitUntil: 'domcontentloaded' });
  let followed = false;
  for (let i = 0; i < 30 && !followed; i++) {
    await sleep(1000);
    followed = new URL(pageB.url()).searchParams.get('v') === VIDEO_B;
  }
  await check('A troca de vídeo e B vai junto', followed, pageB.url());
  if (followed) {
    await Promise.all([waitNoAd(pageA, 'A'), waitNoAd(pageB, 'B')]);
    await sleep(2000);
    await pageA.locator('#movie_player').focus();
    await pageA.keyboard.press('k');
    r = await settle(synced, { timeout: 15000 });
    await check('no vídeo novo, play sincroniza', r.ok && r.last.a.vid === VIDEO_B && r.last.b.vid === VIDEO_B, fmt(r));
    series = await steady(4);
    await check('no vídeo novo, diferença abaixo de 60 ms', series.every((x) => Math.abs(x) < 60), `ms: ${series.join(', ')}`);
  }

  // popup como página, apontando para a aba A
  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 300, height: 420 });
  await popup.goto(`chrome-extension://${extId}/popup/popup.html?tab=${tabA}`);
  await sleep(1500);
  await popup.screenshot({ path: path.join(OUT, 'popup.png') });
  await pageA.screenshot({ path: path.join(OUT, 'a-final.png') });
} catch (err) {
  await check('execução sem erro', false, err.stack || String(err));
} finally {
  await ctx.close();
  rmSync(profile, { recursive: true, force: true });
  const fails = results.filter((r) => !r.ok).length;
  log(`${results.length - fails}/${results.length} passaram`);
  process.exit(fails ? 1 : 0);
}
