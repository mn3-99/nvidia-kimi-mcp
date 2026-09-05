import { chromium } from 'playwright';
async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = (await browser.newContext()).newPage();
  const pg = await page;
  await pg.goto('https://build.nvidia.com/moonshotai/kimi-k3/playground', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForTimeout(10000);
  const info = await pg.evaluate(() => {
    const html = document.documentElement.innerHTML;
    const idx = [];
    for (const kw of ['nv-captcha', 'hcaptcha', 'captcha-token', 'g-recaptcha']) {
      let i = -1, hits = [];
      while ((hits.length < 5) && ((i = html.indexOf(kw, i + 1)) !== -1)) hits.push(html.slice(Math.max(0, i - 200), i + 300));
      idx.push(kw + ' => ' + hits.length + ' hits :: ' + (hits[0] || '').slice(0, 400));
    }
    return {
      scripts: Array.from(document.scripts).map(s => s.src).filter(s => s).slice(0, 40),
      hasHcaptcha: !!document.querySelector('iframe[src*="hcaptcha"]'),
      hcaptchaGlobal: typeof window.hcaptcha !== 'undefined',
      kw: idx,
    };
  });
  console.log(JSON.stringify(info, null, 1).slice(0, 5000));
  await browser.close();
}
main().catch(e => { console.error(e); process.exit(1); });
