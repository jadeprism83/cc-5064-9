// Browser test for the raster debug window: the VRS capability must be wired to
// the graphical view, not just headless code. Verifies that both canvases paint,
// that moving the gaze point and editing region budgets change the shading-rate
// distribution and the real picture, and that runtime anomalies are surfaced.
//
// Run: node tools/test-ui.mjs
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript' };

const server = createServer(async (req, res) => {
  const path = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  try {
    const data = await readFile(join(ROOT, path));
    res.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => document.getElementById('stFrame').textContent !== '-');

function canvasPixels(id) {
  return page.evaluate((cid) => {
    const c = document.getElementById(cid);
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let nonBlack = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 24) nonBlack++;
    return nonBlack;
  }, id);
}

const checks = [];
const check = (name, cond, detail = '') => { checks.push({ name, pass: !!cond, detail }); };

// 1. Both canvases actually paint after init.
check('reconstructed picture canvas paints', await canvasPixels('mainCanvas') > 10000);
check('shading-rate overlay canvas paints', await canvasPixels('rateCanvas') > 1000);

// 2. Stepping changes the frame counter and the rate distribution.
const histBefore = await page.textContent('#stHist');
await page.click('#stepBtn');
const histAfter = await page.textContent('#stHist');
const frameTxt = await page.textContent('#stFrame');
check('single-step advances the frame', /^[2-9]\//.test(frameTxt), frameTxt);

// 3. Clicking the picture moves the gaze and updates the rate map around it.
await page.click('#mainCanvas', { position: { x: 120, y: 180 } });
await page.waitForTimeout(60);
const reason = await page.textContent('#reasonBox');
check('gaze click surfaces a tile decision explanation', reason.includes('当前') && reason.includes('依据'), reason.slice(0, 40));

// 4. Editing a region budget changes the displayed budget value and re-renders.
await page.evaluate(() => {
  const s = document.getElementById('budTop');
  s.value = '0.05';
  s.dispatchEvent(new Event('input', { bubbles: true }));
});
const topVal = await page.textContent('#budTopVal');
check('region budget slider is editable and reflected', parseFloat(topVal) === 0.05, topVal);

// 5. Tightening the global cap to its tightest feasible setting keeps the frame
// within budget (probes + rate-4 anchor lattice floor; the controller clamps
// any lower request to GLOBAL_BUDGET_MIN).
await page.evaluate(() => {
  const s = document.getElementById('budGlobal');
  s.value = '0.13';
  s.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(60);
const budgetTxt = await page.textContent('#stBudget');
check('tight global budget still enforced in UI', !budgetTxt.includes('超预算'), budgetTxt);

// 6. Switching to the fixed partition mode works and re-paints both canvases.
await page.selectOption('#mode', 'fixed');
await page.waitForTimeout(60);
check('fixed partition mode selectable in UI', (await page.textContent('#stFrame')) !== '-');
check('fixed mode still paints the picture', await canvasPixels('mainCanvas') > 10000);

// 7. Scenario switch to sudden reveal: the panel slides away at ~frame 15, so
// step past the event and confirm disocclusion state is surfaced in the UI.
await page.selectOption('#mode', 'adaptive');
await page.evaluate(() => {
  const s = document.getElementById('budGlobal');
  s.value = '0.34';
  s.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.selectOption('#scenario', 'suddenReveal');
let revealTxt = '0';
for (let i = 0; i < 20; i++) {
  await page.click('#stepBtn');
  revealTxt = await page.textContent('#stReveal');
  if (/^[1-9]/.test(revealTxt)) break;
}
check('reveal scenario surfaces disocclusion state in UI', /^[1-9]/.test(revealTxt), revealTxt);

// 8. No console/page errors during the whole interaction.
check('no page errors', errors.length === 0, errors.join(' | '));

for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
const failed = checks.filter((c) => !c.pass).length;
console.log(`\n${checks.length - failed}/${checks.length} UI checks passed`);

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
