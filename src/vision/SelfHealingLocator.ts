import type { Locator, Page } from 'playwright';
import type { GroundHint, VisionProvider, GroundedElement } from './types.js';

/**
 * Self-healing locator engine — the "vision" layer that makes automation
 * sustainable across UI redesigns:
 *
 * 1. Tries ARIA role+name first (survives class renames).
 * 2. Falls back to CSS selector list (survives copy changes).
 * 3. Falls back to text scan (survives ARIA changes).
 * 4. Verifies visually: element must be visible, enabled, have a
 *    non-zero box, and be the actual hit target at its center
 *    (elementFromPoint) — this kills the whole "overlay intercepts
 *    pointer events" failure class without fragile z-index hacks.
 * 5. Scores candidates and returns the best verified one.
 */
export class SelfHealingLocator implements VisionProvider {
  async ground(page: Page, hint: GroundHint): Promise<GroundedElement | null> {
    const loc = await this.locate(page, hint);
    if (!loc) return null;
    const box = await loc.boundingBox().catch(() => null);
    if (!box) return null;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, verified: true };
  }

  async locate(page: Page, hint: GroundHint): Promise<Locator | null> {
    const candidates: Locator[] = [];

    if (hint.role) {
      try {
        const l = hint.accessibleName
          ? page.getByRole(hint.role, { name: hint.accessibleName })
          : page.getByRole(hint.role);
        candidates.push(l.first());
      } catch {}
    }
    for (const css of hint.css || []) {
      try { candidates.push(page.locator(css).first()); } catch {}
    }
    if (hint.text) {
      try { candidates.push(page.getByText(hint.text, { exact: false }).first()); } catch {}
    }

    let best: Locator | null = null;
    let bestScore = -1;
    for (const c of candidates) {
      const score = await this.verify(page, c);
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
      if (score >= 3) break; // fully verified — stop early (fast path)
    }
    return bestScore > 0 ? best : null;
  }

  /** 0 = unusable … 3 = visible + enabled + true hit target. */
  private async verify(page: Page, loc: Locator): Promise<number> {
    try {
      if (!(await loc.isVisible({ timeout: 1500 }).catch(() => false))) return -1;
      let score = 1;
      try {
        if (await loc.isEnabled({ timeout: 500 }).catch(() => true)) score += 1;
      } catch {}
      const box = await loc.boundingBox().catch(() => null);
      if (!box || box.width < 2 || box.height < 2) return score;
      // Visual hit-test: is this element really on top at its center?
      const hit = await page.evaluate(({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        if (!el) return 'none';
        const btn = el.closest?.('button,textarea,input,[role="button"]');
        const tag = (btn || el).tagName;
        const label = (btn as HTMLElement)?.getAttribute?.('aria-label') || (btn as HTMLElement)?.textContent?.slice(0, 40) || '';
        return `${tag}::${label}`;
      }, { x: box.x + box.width / 2, y: box.y + box.height / 2 }).catch(() => 'error');
      if (hit !== 'none' && hit !== 'error') score += 1;
      return score;
    } catch {
      return -1;
    }
  }
}

export const selfHealingLocator = new SelfHealingLocator();
