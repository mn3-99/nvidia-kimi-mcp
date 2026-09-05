import type { Page } from 'playwright';

/**
 * Vision-grounding contract.
 *
 * Default engine (SelfHealingLocator) needs no external model: it fuses
 * ARIA roles + accessible names + CSS + hit-testing (elementFromPoint).
 * If VISION_ENDPOINT (OpenAI-compatible chat/completions with vision) is
 * set, ExternalVisionProvider can ground novel UIs by coordinates.
 */
export interface GroundHint {
  role?: 'button' | 'textbox' | 'dialog';
  accessibleName?: string | RegExp;
  css?: string[];
  text?: string;
}

export interface GroundedElement {
  x: number;
  y: number;
  verified: boolean;
}

export interface VisionProvider {
  ground(page: Page, hint: GroundHint): Promise<GroundedElement | null>;
}
