import { browserManager } from '../browser/BrowserManager.js';
export class PlaygroundPage {
    page;
    lastSentMessage = '';
    constructor(page) {
        this.page = page || browserManager.getPage();
    }
    async findFirst(selectors) {
        for (const sel of selectors) {
            try {
                const loc = this.page.locator(sel).first();
                if (await loc.isVisible({ timeout: 1000 }))
                    return loc;
            }
            catch { }
        }
        return null;
    }
    async removeOverlays() {
        // Method 1: Playwright locator click (works with React)
        try {
            await this.page.getByText('Acknowledge & Continue').click({ force: true, timeout: 5000 });
            await this.page.waitForTimeout(2000);
        }
        catch { }
        // Method 2: Try clicking by role
        try {
            await this.page.getByRole('button', { name: /acknowledge/i }).click({ force: true, timeout: 3000 });
            await this.page.waitForTimeout(2000);
        }
        catch { }
        // Method 3: Try Review Terms
        try {
            await this.page.getByText('Review Terms').click({ force: true, timeout: 3000 });
            await this.page.waitForTimeout(2000);
        }
        catch { }
        // Method 4: Accept cookies
        try {
            await this.page.getByText('Accept All').click({ force: true, timeout: 3000 });
            await this.page.waitForTimeout(1000);
        }
        catch { }
        try {
            await this.page.getByText('Save and Accept').click({ force: true, timeout: 3000 });
            await this.page.waitForTimeout(1000);
        }
        catch { }
        // Method 5: Close any remaining modals by X button
        try {
            await this.page.locator('[aria-label*="close" i], [aria-label*="Close"]').first().click({ force: true, timeout: 2000 });
            await this.page.waitForTimeout(500);
        }
        catch { }
        // Method 6: Remove overlay elements
        await this.page.evaluate(() => {
            document.querySelectorAll('[class*="backdrop"], [class*="z-40"], [class*="z-50"]').forEach(el => {
                if (el instanceof HTMLElement)
                    el.remove();
            });
        }).catch(() => { });
        await this.page.waitForTimeout(500);
    }
    async sendMessage(message) {
        await this.removeOverlays();
        const input = await this.findFirst([
            'textarea[aria-label="chat prompt"]',
            'textarea.nv-text-area-element',
            'textarea',
        ]);
        if (!input)
            throw new Error('Message input not found');
        this.lastSentMessage = message;
        await input.click({ force: true });
        await this.page.waitForTimeout(300);
        await input.fill('');
        await this.page.waitForTimeout(300);
        await input.fill(message);
        await this.page.waitForTimeout(500);
        // Click Send button
        for (let i = 0; i < 30; i++) {
            const btn = await this.findFirst([
                'button[aria-label="Send"]:not([disabled])',
                'button[aria-label*="send" i]:not([disabled])',
            ]);
            if (btn) {
                await btn.click({ force: true });
                return;
            }
            await this.page.waitForTimeout(300);
        }
        throw new Error('Send button not found or not enabled');
    }
    async waitForResponse(timeout = 90000) {
        const start = Date.now();
        let lastText = '';
        let stableCount = 0;
        while (Date.now() - start < timeout) {
            // Check if stop button is still visible (response still streaming)
            const stopBtn = await this.findFirst([
                'button[aria-label*="stop" i]',
                'button[aria-label*="إيقاف" i]',
            ]);
            const isStreaming = stopBtn && await stopBtn.isVisible().catch(() => false);
            const currentText = await this.extractModelResponse();
            if (isStreaming) {
                stableCount = 0;
                lastText = currentText;
                await this.page.waitForTimeout(500);
                continue;
            }
            if (currentText && currentText === lastText) {
                stableCount++;
                if (stableCount >= 3) {
                    console.error('[Playground] Response stable after %dms', Date.now() - start);
                    break;
                }
            }
            else {
                stableCount = 0;
                lastText = currentText;
            }
            await this.page.waitForTimeout(1000);
        }
        return lastText;
    }
    async extractModelResponse() {
        try {
            return await this.page.evaluate(() => {
                // Look for response containers - NVIDIA uses specific patterns
                const selectors = [
                    '[class*="response"]',
                    '[class*="message"]',
                    '[class*="assistant"]',
                    '[class*="output"]',
                    '[class*="answer"]',
                    '[class*="result"]',
                    '[data-testid*="response"]',
                    '[data-testid*="message"]',
                    '.markdown-body',
                    '.prose',
                ];
                // Get all elements that might contain responses
                const candidates = [];
                for (const sel of selectors) {
                    document.querySelectorAll(sel).forEach(el => candidates.push(el));
                }
                // Find the last substantial text block (the latest response)
                let bestText = '';
                for (const el of candidates) {
                    const text = el.innerText?.trim();
                    if (text && text.length > 5 && !text.includes('GOVERNING TERMS')) {
                        if (text.length > bestText.length) {
                            bestText = text;
                        }
                    }
                }
                // Also try to get text after "Reasoning Complete" or similar markers
                const allText = document.body.innerText;
                const markers = ['Reasoning Complete', 'Response', 'Answer', 'Result'];
                for (const marker of markers) {
                    const idx = allText.lastIndexOf(marker);
                    if (idx > 0) {
                        const afterMarker = allText.substring(idx + marker.length).trim();
                        // Get lines after the marker, skip empty lines
                        const lines = afterMarker.split('\n').filter(l => l.trim() && !l.includes('Tools') && !l.includes('Parameters') && !l.includes('GOVERNING'));
                        const responseText = lines.slice(0, 20).join('\n').trim();
                        if (responseText.length > bestText.length) {
                            bestText = responseText;
                        }
                    }
                }
                return bestText;
            });
        }
        catch {
            return '';
        }
    }
    async getLastResponse() {
        return this.extractModelResponse();
    }
    async takeScreenshot(path) {
        return browserManager.screenshot(path);
    }
}
export let playgroundPage;
export function initPlaygroundPage(page) {
    playgroundPage = new PlaygroundPage(page);
    return playgroundPage;
}
//# sourceMappingURL=PlaygroundPage.js.map