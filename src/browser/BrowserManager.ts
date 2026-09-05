import { chromium, Browser, BrowserContext, Page, LaunchOptions } from 'playwright';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];

async function nativeClick(page: Page, text: string): Promise<boolean> {
  const coords = await page.evaluate((text) => {
    const btns = Array.from(document.querySelectorAll('button'));
    const btn = btns.find(b => b.textContent?.includes(text));
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, text);
  if (coords) {
    await page.mouse.click(coords.x, coords.y);
    return true;
  }
  return false;
}

async function dismissOverlays(page: Page): Promise<void> {
  // Remove cookie consent + AI modal + all overlays via DOM removal
  await page.evaluate(() => {
    document.querySelectorAll('[class*="cookie"], [class*="consent"], [id*="onetrust"], [class*="onetrust"]').forEach(el => el.remove());
    document.querySelectorAll('[class*="backdrop"], [class*="z-40"], [class*="z-50"]').forEach(el => el.remove());
    document.querySelectorAll('button').forEach(btn => {
      const text = btn.textContent?.trim().toLowerCase();
      if (text === 'accept all' || text === 'save and accept' || text?.includes('acknowledge')) {
        btn.click();
      }
    });
  }).catch(() => {});
}

export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private headless: boolean;

  constructor(headless = true) {
    this.headless = headless;
  }

  async initialize(): Promise<Page> {
    const launchOpts: LaunchOptions = {
      headless: this.headless,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    };

    this.browser = await chromium.launch(launchOpts);
    this.context = await this.browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
      bypassCSP: true,
    });

    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(60000);

    await this.page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      (window as any).chrome = { runtime: {} };
    });

    this.page.on('crash', () => {
      console.error('[Browser] Page crashed');
      this.page = null;
    });

    await this.page.goto('https://build.nvidia.com/moonshotai/kimi-k3/playground', {
      waitUntil: 'networkidle',
      timeout: 60000,
    });

    // Phase 1: Accept cookies via native Playwright mouse click
    console.error('[Browser] Accepting cookies...');
    await nativeClick(this.page, 'Accept All');
    await this.page.waitForTimeout(2000);

    // Phase 2: Acknowledge AI modal via native Playwright mouse click
    console.error('[Browser] Acknowledging AI modal...');
    await nativeClick(this.page, 'Acknowledge & Continue');
    await this.page.waitForTimeout(5000);
    await this.page.waitForLoadState('networkidle').catch(() => {});
    await this.page.waitForTimeout(2000);

    // Phase 3: Remove leftover overlays
    await dismissOverlays(this.page);
    console.error('[Browser] Overlays cleared');

    return this.page;
  }

  async removeOverlays(): Promise<void> {
    if (!this.page) return;
    await dismissOverlays(this.page);
  }

  getPage(): Page {
    if (!this.page) throw new Error('Browser not initialized');
    return this.page;
  }

  async screenshot(path?: string): Promise<Buffer> {
    if (!this.page) throw new Error('Browser not initialized');
    return this.page.screenshot({ path, fullPage: true });
  }

  async close(): Promise<void> {
    try { if (this.page) await this.page.close(); } catch {}
    try { if (this.context) await this.context.close(); } catch {}
    try { if (this.browser) await this.browser.close(); } catch {}
    this.page = null;
    this.context = null;
    this.browser = null;
  }
}

export const browserManager = new BrowserManager(process.env.HEADLESS !== 'false');
