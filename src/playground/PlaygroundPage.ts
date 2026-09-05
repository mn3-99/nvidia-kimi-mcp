import { Page, Locator } from 'playwright';
import { browserManager } from '../browser/BrowserManager.js';

export class PlaygroundPage {
  private page: Page;
  private lastSentMessage = '';

  constructor(page?: Page) {
    this.page = page || browserManager.getPage();
  }

  private async nativeClick(text: string): Promise<boolean> {
    const coords = await this.page.evaluate((text) => {
      const btns = Array.from(document.querySelectorAll('button'));
      const btn = btns.find(b => b.textContent?.includes(text));
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, text);
    if (coords) {
      await this.page.mouse.click(coords.x, coords.y);
      return true;
    }
    return false;
  }

  async sendMessage(message: string): Promise<void> {
    // Dismiss any overlays before typing
    await browserManager.removeOverlays();

    // Wait for textarea with retries
    let textarea: Locator | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      textarea = this.page.locator('textarea[aria-label="chat prompt"]');
      try {
        await textarea.waitFor({ state: 'visible', timeout: 5000 });
        break;
      } catch {
        await browserManager.removeOverlays();
        await this.page.waitForTimeout(2000);
      }
    }
    if (!textarea) throw new Error('Message input not found');

    this.lastSentMessage = message;

    // Type message via native value setter (triggers React state)
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

    // Verify send is enabled
    const sendEnabled = await this.page.evaluate(() => {
      const btn = document.querySelector('button[aria-label="Send"]');
      return btn ? !(btn as HTMLButtonElement).disabled : false;
    });
    if (!sendEnabled) throw new Error('Send button not enabled after typing');

    // Click send via native Playwright mouse click
    const sendCoords = await this.page.evaluate(() => {
      const btn = document.querySelector('button[aria-label="Send"]');
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (!sendCoords) throw new Error('Send button not found');
    await this.page.mouse.click(sendCoords.x, sendCoords.y);

    // Dismiss any overlays that may reappear
    await this.page.waitForTimeout(2000);
    await browserManager.removeOverlays();
  }

  async waitForResponse(timeout = 90000): Promise<string> {
    const start = Date.now();
    let lastText = '';
    let stableCount = 0;

    while (Date.now() - start < timeout) {
      // Dismiss overlays periodically
      if ((Date.now() - start) % 15000 < 1000) {
        await browserManager.removeOverlays();
      }

      // Check if still streaming
      const streaming = await this.page.evaluate(() => {
        // Check for loading indicators
        const loadingBars = document.querySelectorAll('[class*="loading"], [class*="spinner"], [class*="thinking"], [class*="nv-streaming"], [class*="streaming"], [class*="skeleton"]');
        if (loadingBars.length > 0) return true;
        // Check for stop button
        for (const b of Array.from(document.querySelectorAll('button'))) {
          const l = (b.getAttribute('aria-label') || '').toLowerCase();
          if (l.includes('stop') || l.includes('إيقاف') || l.includes('cancel')) return true;
        }
        return false;
      });

      const currentText = await this.extractModelResponse();

      if (streaming) {
        stableCount = 0;
        lastText = currentText;
        await this.page.waitForTimeout(500);
        continue;
      }

      if (currentText && currentText.length > 200 && currentText === lastText) {
        stableCount++;
        if (stableCount >= 3) {
          console.error('[Playground] Response stable after %dms', Date.now() - start);
          break;
        }
      } else {
        stableCount = 0;
        lastText = currentText;
      }
      await this.page.waitForTimeout(1000);
    }
    return lastText;
  }

  private async extractModelResponse(): Promise<string> {
    try {
      const sentMsg = this.lastSentMessage;
      return await this.page.evaluate((sentMsg) => {
        // Method 1: Look for rendered markdown in response blocks
        const mdBlocks = document.querySelectorAll('.markdown-body, .prose, [class*="response-content"], [class*="message-content"]');
        let lastResponse = '';
        for (const md of Array.from(mdBlocks)) {
          const t = (md as HTMLElement).innerText?.trim();
          if (t && t.length > 200 && !t.includes('GOVERNING') && !t.includes('Accept All') && !t.includes('please do not upload')) {
            lastResponse = t;
          }
        }
        if (lastResponse) return lastResponse;

        // Method 2: Look for substantial text blocks after user message
        const allBlocks = document.querySelectorAll('div, p, span');
        let foundUserMsg = false;
        for (const block of Array.from(allBlocks)) {
          const t = (block as HTMLElement).innerText?.trim();
          if (t?.includes(sentMsg?.substring(0, 30) || 'NEVER_MATCH')) { foundUserMsg = true; continue; }
          if (foundUserMsg && t && t.length > 200 && !t.includes('GOVERNING') && !t.includes('Accept All') && !t.includes('please do not upload') && !t.includes('Refine your idea')) {
            return t;
          }
        }
        return '';
      }, sentMsg) as string;
    } catch {
      return '';
    }
  }

  async getLastResponse(): Promise<string> {
    return this.extractModelResponse();
  }

  async takeScreenshot(path?: string): Promise<Buffer> {
    return browserManager.screenshot(path);
  }
}

export let playgroundPage: PlaygroundPage;
export function initPlaygroundPage(page?: Page): PlaygroundPage {
  playgroundPage = new PlaygroundPage(page);
  return playgroundPage;
}
