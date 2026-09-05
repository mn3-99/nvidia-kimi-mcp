import { chromium, Browser, BrowserContext, Page, LaunchOptions } from 'playwright';
import { OVERLAY_KILLER_SOURCE } from './OverlayKiller.js';
import { profileDir } from './SessionStore.js';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Tracker/ad beacons blocked for speed — never the inference or captcha hosts.
const BLOCKED_RE = /segment\.io|segment\.com|datadoghq|hotjar|doubleclick|googletagmanager|facebook\.net|bing\.com|contentsquare|cookielaw\.org\/cookieconsentpub\/v1\/geo|hcaptcha\.com\/logo|licdn\.com/i;

async function nativeClick(page: Page, text: string): Promise<boolean> {
  const coords = await page.evaluate((text) => {
    const btns = Array.from(document.querySelectorAll('button'));
    const btn = btns.find(b => b.textContent?.includes(text));
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, text).catch(() => null);
  if (coords) {
    await page.mouse.click(coords.x, coords.y);
    return true;
  }
  return false;
}

export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private headless: boolean;
  private ready = false;

  constructor(headless = true) {
    this.headless = headless;
  }

  async initialize(): Promise<Page> {
    if (this.ready && this.page) return this.page;
    const launchOpts: LaunchOptions = {
      headless: this.headless,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    };

    // Persistent profile: consent + captcha cookies survive restarts → warm start.
    this.browser = await chromium.launch(launchOpts);
    this.context = await this.browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: USER_AGENT,
      bypassCSP: true,
      storageState: undefined,
    });
    // Load previous session if present
    try {
      const { readFileSync, existsSync } = await import('fs');
      const { join } = await import('path');
      const f = join(process.cwd(), '.storage-state.json');
      if (existsSync(f)) {
        const state = JSON.parse(readFileSync(f, 'utf8'));
        await this.context.addCookies(state.cookies || []);
        console.error('[Browser] Loaded saved session cookies');
      }
    } catch {}

    // Kill overlay class at document_start on every navigation
    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      (window as any).chrome = { runtime: {} };
    });
    await this.context.addInitScript({ content: OVERLAY_KILLER_SOURCE });

    // Block trackers for speed
    await this.context.route('**/*', (route) => {
      const url = route.request().url();
      if (BLOCKED_RE.test(url)) return route.abort();
      return route.continue();
    }).catch(() => {});

    // Persist profile dir marker (docs) — actual persistence via storage state below
    profileDir();

    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(60000);
    this.page.on('crash', () => {
      console.error('[Browser] Page crashed');
      this.page = null;
      this.ready = false;
    });

    await this.page.goto('https://build.nvidia.com/moonshotai/kimi-k3/playground', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await this.page.waitForTimeout(5000);

    // Consent + disclaimer (native clicks work with React; killer handles the rest)
    await nativeClick(this.page, 'Accept All').catch(() => {});
    await this.page.waitForTimeout(1500);
    await nativeClick(this.page, 'Acknowledge & Continue').catch(() => {});
    await this.page.waitForTimeout(4000);
    await this.page.waitForLoadState('networkidle').catch(() => {});

    await this.persistSession().catch(() => {});
    console.error('[Browser] Ready');
    this.ready = true;
    return this.page;
  }

  /** Best-effort overlay sweep (the init-script observer already handles most). */
  async removeOverlays(): Promise<void> {
    if (!this.page) return;
    await this.page.evaluate(() => {
      document.querySelectorAll('[class*="cookie"],[class*="consent"],[id*="onetrust"],[class*="onetrust"]').forEach(el => el.remove());
      document.querySelectorAll('[class*="backdrop"]').forEach(el => el.remove());
    }).catch(() => {});
  }

  async persistSession(): Promise<void> {
    if (!this.context) return;
    try {
      const { writeFileSync } = await import('fs');
      const { join } = await import('path');
      const cookies = await this.context.cookies();
      writeFileSync(join(process.cwd(), '.storage-state.json'), JSON.stringify({ cookies }));
    } catch {}
  }

  getPage(): Page {
    if (!this.page) throw new Error('Browser not initialized');
    return this.page;
  }

  isReady(): boolean { return this.ready; }

  async screenshot(path?: string): Promise<Buffer> {
    if (!this.page) throw new Error('Browser not initialized');
    // Viewport-only is 3-5x faster than fullPage; full detail on demand.
    return this.page.screenshot({ path, fullPage: false });
  }

  async close(): Promise<void> {
    try { await this.persistSession(); } catch {}
    try { if (this.page) await this.page.close(); } catch {}
    try { if (this.context) await this.context.close(); } catch {}
    try { if (this.browser) await this.browser.close(); } catch {}
    this.page = null;
    this.context = null;
    this.browser = null;
    this.ready = false;
  }
}

export const browserManager = new BrowserManager(process.env.HEADLESS !== 'false');
