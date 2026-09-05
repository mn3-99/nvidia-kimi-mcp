import { chromium } from 'playwright';
import { writeFileSync } from 'fs';

const calls = [];
async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  page.on('request', r => {
    const url = r.url();
    if (url.includes('nvidia.com') && (url.includes('chat') || url.includes('completion') || url.includes('infer') || url.includes('generate') || url.includes('v1/') || url.includes('api/'))) {
      calls.push({ type: 'REQ', method: r.method(), url, headers: r.headers(), post: r.postData()?.slice(0, 2000) });
    }
  });
  page.on('response', async r => {
    const url = r.url();
    if (url.includes('nvidia.com') && (url.includes('chat') || url.includes('completion') || url.includes('infer') || url.includes('generate') || url.includes('v1/'))) {
      calls.push({ type: 'RES', status: r.status(), url, headers: r.headers() });
    }
  });
  // log ALL fetch/xhr to nvidia build api host
  await page.route('**/*', async route => {
    const req = route.request();
    const url = req.url();
    if ((url.includes('/api/') || url.includes('infer') || url.includes('chat/completions')) && !url.includes('cookielaw') && !url.includes('segment')) {
      console.log('API-CALL:', req.method(), url);
    }
    await route.continue();
  });
  console.log('goto...');
  await page.goto('https://build.nvidia.com/moonshotai/kimi-k3/playground', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(8000);
  // dump all pending XHR URLs seen via performance entries
  const entries = await page.evaluate(() => performance.getEntriesByType('resource').map(e => e.name).filter(u => u.includes('nvidia.com')).slice(0, 100));
  console.log('RESOURCE_URLS:', JSON.stringify(entries, null, 1).slice(0, 4000));
  writeFileSync('/tmp/net_calls.json', JSON.stringify(calls, null, 1));
  console.log('saved', calls.length);
  await browser.close();
}
main().catch(e => { console.error(e); process.exit(1); });
