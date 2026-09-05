import { chromium } from 'playwright';
const seen = new Set();
async function nclick(page, text) {
  const c = await page.evaluate((t) => {
    const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent?.includes(t));
    if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 };
  }, text);
  if (c) await page.mouse.click(c.x, c.y);
}
async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = (await browser.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
  const pg = await page;
  pg.on('request', r => {
    const u = r.url();
    if (r.method() === 'POST' && u.includes('nvidia.com') && !u.includes('client-logger') && !u.includes('segment') && !u.includes('datadog')) {
      if (!seen.has(u)) { seen.add(u); console.log('POST:', u, '| body:', (r.postData()||'').slice(0, 600)); }
    }
  });
  pg.on('websocket', ws => console.log('WS:', ws.url()));
  await pg.goto('https://build.nvidia.com/moonshotai/kimi-k3/playground', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForTimeout(6000);
  await nclick(pg, 'Accept All'); await pg.waitForTimeout(2000);
  await nclick(pg, 'Acknowledge & Continue'); await pg.waitForTimeout(5000);
  await pg.evaluate(() => {
    document.querySelectorAll('[class*="cookie"],[id*="onetrust"],[class*="onetrust"]').forEach(e => e.remove());
    document.querySelectorAll('[class*="backdrop"],[class*="z-40"],[class*="z-50"]').forEach(e => e.remove());
  });
  const ta = pg.locator('textarea[aria-label="chat prompt"]');
  await ta.waitFor({ state: 'visible', timeout: 15000 });
  await ta.click({ force: true });
  await pg.evaluate(() => {
    const t = document.querySelector('textarea[aria-label="chat prompt"]');
    const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    s ? s.call(t, 'hi') : t.value = 'hi';
    t.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await pg.waitForTimeout(1000);
  const sc = await pg.evaluate(() => { const b = document.querySelector('button[aria-label="Send"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x+r.width/2, y: r.y+r.height/2 }; });
  if (sc) await pg.mouse.click(sc.x, sc.y);
  console.log('sent, watching 45s...');
  await pg.waitForTimeout(45000);
  console.log('DONE. unique POSTs:', [...seen]);
  await browser.close();
}
main().catch(e => { console.error(e); process.exit(1); });
