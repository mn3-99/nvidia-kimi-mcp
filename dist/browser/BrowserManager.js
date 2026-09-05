import { chromium } from 'playwright';
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];
const MODAL_SELECTORS = [
    '#onetrust-accept-btn-handler',
    'button.save-preference-btn-handler',
    'button:has-text("Accept All")',
    '[role="dialog"] button:first-child',
    'button[aria-label="Close"]',
    'button[aria-label="إغلاق"]',
    '.modal-close',
    'button[id*="accept"]',
    'button[class*="cookie"]',
];
export class BrowserManager {
    browser = null;
    context = null;
    page = null;
    headless;
    constructor(headless = true) {
        this.headless = headless;
    }
    async initialize() {
        const launchOpts = {
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
            window.chrome = { runtime: {} };
        });
        this.page.on('crash', () => {
            console.error('[Browser] Page crashed');
            this.page = null;
        });
        await this.page.goto('https://build.nvidia.com/moonshotai/kimi-k3/playground', {
            waitUntil: 'networkidle',
            timeout: 60000,
        });
        await this.closeModals();
        try {
            await this.page.waitForTimeout(3000);
        }
        catch { }
        await this.closeModals();
        return this.page;
    }
    async closeModals() {
        if (!this.page)
            return;
        // Click all known accept/dismiss buttons
        for (const sel of MODAL_SELECTORS) {
            try {
                const els = await this.page.$$(sel);
                for (const el of els) {
                    if (await el.isVisible()) {
                        await el.click({ timeout: 2000, force: true }).catch(() => { });
                        await this.page.waitForTimeout(500);
                    }
                }
            }
            catch { }
        }
        // Click "Review Terms" button if present
        await this.page.click('button:has-text("Review Terms")', { force: true, timeout: 3000 }).catch(() => { });
        // Remove overlay divs that intercept pointer events
        await this.page.evaluate(() => {
            document.querySelectorAll('[class*="backdrop-blur"], [class*="z-40"], [class*="overlay"]').forEach(el => {
                if (el instanceof HTMLElement && el.style.position === 'absolute')
                    el.remove();
            });
        }).catch(() => { });
        await this.page.keyboard.press('Escape').catch(() => { });
    }
    getPage() {
        if (!this.page)
            throw new Error('Browser not initialized');
        return this.page;
    }
    async screenshot(path) {
        if (!this.page)
            throw new Error('Browser not initialized');
        return this.page.screenshot({ path, fullPage: true });
    }
    async close() {
        try {
            if (this.page)
                await this.page.close();
        }
        catch { }
        try {
            if (this.context)
                await this.context.close();
        }
        catch { }
        try {
            if (this.browser)
                await this.browser.close();
        }
        catch { }
        this.page = null;
        this.context = null;
        this.browser = null;
    }
}
export const browserManager = new BrowserManager(process.env.HEADLESS !== 'false');
//# sourceMappingURL=BrowserManager.js.map