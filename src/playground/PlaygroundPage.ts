import { Page, Locator } from 'playwright';
import { browserManager } from '../browser/BrowserManager.js';
import { DirectClient } from '../net/DirectClient.js';
import { selfHealingLocator } from '../vision/SelfHealingLocator.js';
import { ExternalVisionProvider } from '../vision/ExternalVisionProvider.js';

export type ChatMode = 'auto' | 'direct' | 'ui';

const externalVision = new ExternalVisionProvider();

export class PlaygroundPage {
  private page: Page;
  private lastSentMessage = '';
  private lastResponse = '';

  constructor(page?: Page) {
    this.page = page || browserManager.getPage();
  }

  private liveLog(msg: string): void {
    // Live thinking/response relay on stderr while the user waits
    console.error(`[Kimi] ${msg}`);
  }

  async sendMessage(message: string, mode: ChatMode = 'auto'): Promise<void> {
    this.refreshPage();
    this.lastSentMessage = message;
    this.lastResponse = '';

    if (mode === 'direct' || mode === 'auto') {
      try {
        this.liveLog('Direct path: calling native inference API…');
        const started = Date.now();
        let lastBeat = 0;
        const text = await DirectClient.chat(this.page, [{ role: 'user', content: message }], {
          onProgress: (partial) => {
            const now = Date.now();
            if (now - lastBeat > 5000) {
              lastBeat = now;
              this.liveLog(`streaming… ${partial.length} chars (${((now - started) / 1000).toFixed(0)}s)`);
            }
          },
        });
        this.lastResponse = text;
        this.liveLog(`Direct path done: ${text.length} chars in ${((Date.now() - started) / 1000).toFixed(1)}s`);
        await browserManager.persistSession().catch(() => {});
        return;
      } catch (e) {
        this.liveLog(`Direct path failed (${e instanceof Error ? e.message : e}), falling back to vision UI…`);
        if (mode === 'direct') throw e;
      }
    }

    await this.sendViaUI(message);
  }

  /** Vision-driven UI fallback: self-healing locators + hit-test verification. */
  private async sendViaUI(message: string): Promise<void> {
    await browserManager.removeOverlays();

    const textarea = await selfHealingLocator.locate(this.page, {
      role: 'textbox',
      accessibleName: /chat prompt/i,
      css: ['textarea[aria-label="chat prompt"]', 'textarea.nv-text-area-element', 'textarea'],
    });
    if (!textarea) throw new Error('Message input not found');

    await textarea.click({ force: true });
    await this.page.waitForTimeout(300);
    await this.page.evaluate((text) => {
      const ta = document.querySelector('textarea[aria-label="chat prompt"]');
      if (!ta) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) setter.call(ta, text);
      else (ta as HTMLTextAreaElement).value = text;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
    }, message);
    await this.page.waitForTimeout(1000);

    // Locate Send via ARIA first (survives redesigns), external VLM last
    let send = await selfHealingLocator.locate(this.page, {
      role: 'button',
      accessibleName: /^send$/i,
      css: ['button[aria-label="Send"]:not([disabled])', 'button[aria-label*="send" i]:not([disabled])'],
    });
    if (!send && process.env.VISION_ENDPOINT) {
      const g = await externalVision.ground(this.page, { accessibleName: 'Send' });
      if (g) {
        await this.page.mouse.click(g.x, g.y);
        await this.page.waitForTimeout(2000);
        await browserManager.removeOverlays();
        return;
      }
    }
    if (!send) {
      // One more sweep then retry once (transient overlay race)
      await browserManager.removeOverlays();
      await this.page.waitForTimeout(1500);
      send = await selfHealingLocator.locate(this.page, {
        role: 'button',
        accessibleName: /^send$/i,
        css: ['button[aria-label="Send"]:not([disabled])'],
      });
    }
    if (!send) throw new Error('Send button not found or not enabled');

    const box = await send.boundingBox();
    if (box) await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    else await send.click({ force: true });
    await this.page.waitForTimeout(2000);
    await browserManager.removeOverlays();
  }

  async waitForResponse(timeout = 300000): Promise<string> {
    // Direct path already has the full text — return instantly.
    if (this.lastResponse) return this.lastResponse;

    const start = Date.now();
    let lastText = '';
    let stableCount = 0;

    while (Date.now() - start < timeout) {
      const streaming = await this.page.evaluate(() => {
        if (document.querySelectorAll('[class*="loading"],[class*="spinner"],[class*="thinking"],[class*="nv-streaming"],[class*="streaming"],[class*="skeleton"]').length > 0) return true;
        for (const b of Array.from(document.querySelectorAll('button'))) {
          const l = (b.getAttribute('aria-label') || '').toLowerCase();
          if (l.includes('stop') || l.includes('cancel')) return true;
        }
        return false;
      }).catch(() => false);

      const currentText = await this.extractModelResponse();
      if (currentText.length > lastText.length + 200) {
        this.liveLog(`thinking… ${currentText.length} chars`);
      }

      if (streaming) {
        stableCount = 0;
        lastText = currentText;
        await this.page.waitForTimeout(2000);
        continue;
      }
      if (currentText && currentText.length > 200 && currentText === lastText) {
        if (++stableCount >= 3) break;
      } else {
        stableCount = 0;
        lastText = currentText;
      }
      await this.page.waitForTimeout(1500);
    }
    this.lastResponse = lastText;
    return lastText;
  }

  private async extractModelResponse(): Promise<string> {
    try {
      const sentMsg = this.lastSentMessage;
      return await this.page.evaluate((sentMsg) => {
        const BAD = ['GOVERNING', 'Accept All', 'please do not upload', 'Refine your idea', 'Review Terms'];
        const clean = (t?: string | null) => t && t.length > 200 && !BAD.some(b => t.includes(b));
        const mdBlocks = document.querySelectorAll('.markdown-body,.prose,[class*="response-content"],[class*="message-content"]');
        let last = '';
        for (const md of Array.from(mdBlocks)) {
          const t = (md as HTMLElement).innerText?.trim();
          if (clean(t)) last = t as string;
        }
        if (last) return last;
        let seenUser = false;
        for (const block of Array.from(document.querySelectorAll('div,p,span'))) {
          const t = (block as HTMLElement).innerText?.trim();
          if (!t) continue;
          if (!seenUser && sentMsg && t.includes(sentMsg.substring(0, 30))) { seenUser = true; continue; }
          if ((seenUser || !sentMsg) && clean(t)) return t as string;
        }
        return '';
      }, sentMsg) as string;
    } catch {
      return '';
    }
  }

  async getLastResponse(): Promise<string> {
    if (this.lastResponse) return this.lastResponse;
    return this.extractModelResponse();
  }

  async takeScreenshot(path?: string): Promise<Buffer> {
    return browserManager.screenshot(path);
  }

  private refreshPage(): void {
    try { this.page = browserManager.getPage(); } catch {}
  }

  // Keep for API compat
  async ensureReady(): Promise<void> {
    this.refreshPage();
    await browserManager.removeOverlays();
    const ta: Locator = this.page.locator('textarea[aria-label="chat prompt"]');
    await ta.waitFor({ state: 'visible', timeout: 15000 });
  }
}

export let playgroundPage: PlaygroundPage;
export function initPlaygroundPage(page?: Page): PlaygroundPage {
  playgroundPage = new PlaygroundPage(page);
  return playgroundPage;
}
