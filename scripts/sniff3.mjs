import { chromium } from 'playwright';
import { writeFileSync } from 'fs';
async function nclick(page, text) {
  const c = await page.evaluate((t) => {
    const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent?.includes(t));
    if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 };
  }, text);
  if (c) await page.mouse.click(c.x, c.y);
}
async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  let captured = null;
  page.on('request', async r => {
    if (r.url().includes('/v2/predict/models/')) {
      captured = { url: r.url(), method: r.method(), headers: r.headers(), body: r.postData() };
      console.log('CAPTURED HEADERS:', JSON.stringify(r.headers(), null, 1));
    }
  });
  await page.goto('https://build.nvidia.com/moonshotai/kimi-k3/playground', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);
  await nclick(page, 'Accept All'); await page.waitForTimeout(2000);
  await nclick(page, 'Acknowledge & Continue'); await page.waitForTimeout(5000);
  await page.evaluate(() => {
    document.querySelectorAll('[class*="cookie"],[id*="onetrust"]').forEach(e => e.remove());
    document.querySelectorAll('[class*="backdrop"],[class*="z-40"],[class*="z-50"]').forEach(e => e.remove());
  });
  const cookies = await ctx.cookies();
  console.log('COOKIES:', cookies.map(c => `${c.name}=${c.value.slice(0,40)}...@${c.domain}`).join('\n'));
  const ta = page.locator('textarea[aria-label="chat prompt"]');
  await ta.waitFor({ state: 'visible', timeout: 15000 });
  await ta.click({ force: true });
  await page.evaluate(() => {
    const t = document.querySelector('textarea[aria-label="chat prompt"]');
    const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    s ? s.call(t, 'say ok') : t.value = 'say ok';
    t.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(1000);
  const sc = await page.evaluate(() => { const b = document.querySelector('button[aria-label="Send"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x+r.width/2, y: r.y+r.height/2 }; });
  if (sc) await page.mouse.click(sc.x, sc.y);
  await page.waitForTimeout(20000);
  if (captured) writeFileSync('/tmp/api_capture.json', JSON.stringify({ ...captured, cookies: cookies.map(c => ({ name: c.name, domain: c.domain, path: c.path })) }, null, 1));
  console.log('done, captured:', !!captured);
  await browser.close();
}
main().catch(e => { console.error(e); process.exit(1); });
