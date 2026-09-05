import type { Page } from 'playwright';
import type { GroundHint, GroundedElement, VisionProvider } from './types.js';

/**
 * Optional external VLM grounder (e.g. UI-TARS / Molmo / any
 * OpenAI-compatible vision endpoint). Enabled only when VISION_ENDPOINT
 * is set — otherwise the offline SelfHealingLocator is used.
 *
 * Expected endpoint: POST {model, messages:[{role,user,content:[{text},
 * {image_url:{url:data:image/png;base64,...}}]}]} → assistant text JSON
 * {"x":0-1000,"y":0-1000} normalized coordinates.
 */
export class ExternalVisionProvider implements VisionProvider {
  async ground(page: Page, hint: GroundHint): Promise<GroundedElement | null> {
    const endpoint = process.env.VISION_ENDPOINT;
    if (!endpoint) return null;
    try {
      const shot = await page.screenshot({ fullPage: false });
      const target = hint.accessibleName?.toString() || hint.text || hint.css?.[0] || 'target element';
      const body = {
        model: process.env.VISION_MODEL || 'ui-grounding',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: `Locate the UI element: ${target}. Reply ONLY JSON {"x":<0-1000>,"y":<0-1000>}.` },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,' + shot.toString('base64') } },
          ],
        }],
        max_tokens: 50,
      };
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(process.env.VISION_API_KEY ? { authorization: `Bearer ${process.env.VISION_API_KEY}` } : {}),
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) return null;
      const text = await res.text();
      const m = text.match(/\{[^}]*"x"[^}]*\}/);
      if (!m) return null;
      const { x, y } = JSON.parse(m[0]);
      const vp = page.viewportSize() || { width: 1920, height: 1080 };
      return { x: (x / 1000) * vp.width, y: (y / 1000) * vp.height, verified: false };
    } catch {
      return null;
    }
  }
}
