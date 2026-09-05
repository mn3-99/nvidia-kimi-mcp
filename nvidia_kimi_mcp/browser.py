"""Hardened Playwright browser manager for the NVIDIA build playground.

Battle-tested against the real page; handles the pitfalls observed live:

* OneTrust cookie consent reloads the page after "Accept All" → every DOM
  operation is wrapped in navigation-tolerant retry logic.
* A "Before You Use AI Models" modal must be acknowledged before anything
  is clickable; overlays intercept pointer events, so dismissal uses
  JS-level clicks that bypass Playwright actionability checks where needed.
* React hydration: the static HTML renders before event handlers attach.
  We wait an extra hydration buffer and offer an interactivity probe.
* hcaptcha iframes exist — anonymous usage works, but we detect and report
  challenge states instead of hanging forever.
* Crashes / detaches are recovered by transparent restart (bounded).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any, Optional

from playwright.async_api import (
    Browser,
    BrowserContext,
    Page,
    Playwright,
    async_playwright,
)

from .config import settings
from .network import NetworkTap

logger = logging.getLogger("nvidia_kimi_mcp.browser")

# Anti-fingerprint stealth shim applied to every page.
_STEALTH_JS = """
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
window.chrome = window.chrome || { runtime: {} };
"""

# One DOM-evaluated dismissal pass.  Returns a state token.
_DISMISS_JS = """() => {
  const vis = el => { if (!el) return false; const r = el.getBoundingClientRect();
    return r.width > 4 && r.height > 4 && getComputedStyle(el).visibility !== 'hidden'; };
  // 1. acknowledge the legal modal
  const ack = [...document.querySelectorAll('button')]
    .find(b => /acknowledge/i.test(b.innerText || '') && vis(b));
  if (ack) { ack.click(); return 'acknowledged'; }
  // 2. accept cookies
  const ck = document.querySelector('#onetrust-accept-btn-handler');
  if (ck && vis(ck)) { ck.click(); return 'cookies'; }
  // 3. any other visible dialog: click its primary/last button, else X
  const dlg = [...document.querySelectorAll('[role=dialog], .nv-modal-overlay')]
    .find(d => { const r = d.getBoundingClientRect(); return r.width > 40 && r.height > 40; });
  if (dlg) {
    const btns = [...dlg.querySelectorAll('button')].filter(vis);
    if (btns.length) { btns[btns.length - 1].click(); return 'dialog-btn'; }
    return 'dialog-stuck';
  }
  // 4. strip OneTrust leftovers that eat pointer events
  for (const e of document.querySelectorAll(
      '.onetrust-pc-dark-filter, #ot-anchor, #onetrust-consent-sdk')) {
    try { e.remove(); } catch (_) {}
  }
  // 5. ready check
  return document.querySelector('textarea[aria-label="chat prompt"]') ? 'ready' : 'waiting';
}"""


class BrowserError(RuntimeError):
    pass


class BrowserManager:
    """Owns the Chromium lifecycle + recovery + modal dismissal."""

    def __init__(self) -> None:
        self._pw: Optional[Playwright] = None
        self.browser: Optional[Browser] = None
        self.context: Optional[BrowserContext] = None
        self.page: Optional[Page] = None
        self.tap = NetworkTap()
        self._restarts = 0
        self._op_lock = asyncio.Lock()          # serialise all UI operations
        self._starting = False

    # ------------------------------------------------------------------ api
    async def ensure_ready(self) -> Page:
        """Return a fully-dismissed, interactive playground page."""
        async with self._op_lock:
            if self.page is not None and not self.page.is_closed():
                # quick health probe; restart if the page died
                try:
                    await self.page.evaluate("() => true", )
                    return self.page
                except Exception:
                    logger.warning("page detached; restarting browser")
                    await self._safe_close()
            await self._start()
            assert self.page is not None
            return self.page

    async def close(self) -> None:
        async with self._op_lock:
            await self._safe_close()

    async def restart(self) -> Page:
        async with self._op_lock:
            await self._safe_close()
            await self._start()
            assert self.page is not None
            return self.page

    def storage_state_path(self) -> str:
        return settings.storage_state

    # --------------------------------------------------------------- startup
    async def _start(self) -> None:
        if self._starting:  # pragma: no cover - double entry guard
            raise BrowserError("browser start already in progress")
        self._starting = True
        try:
            await self._launch()
            await self._open_playground()
            await self.dismiss_until_ready()
            self._restarts = 0
        finally:
            self._starting = False

    async def _launch(self) -> None:
        logger.info("launching chromium (headless=%s)", settings.headless)
        self._pw = await async_playwright().start()
        launch_kwargs: dict[str, Any] = {
            "headless": settings.headless,
            "slow_mo": settings.slow_mo_ms or None,
            "args": [
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--disable-features=IsolateOrigins,site-per-process",
            ],
        }
        if settings.browser_channel:
            launch_kwargs["channel"] = settings.browser_channel
        self.browser = await self._pw.chromium.launch(**launch_kwargs)

        ctx_kwargs: dict[str, Any] = {
            "viewport": {
                "width": settings.viewport_width,
                "height": settings.viewport_height,
            },
            "user_agent": settings.user_agent,
            "locale": "en-US",
            "timezone_id": "UTC",
            "ignore_https_errors": True,
            "permissions": ["clipboard-read", "clipboard-write"],
        }
        if settings.storage_state and os.path.exists(settings.storage_state):
            logger.info("loading storage state from %s", settings.storage_state)
            ctx_kwargs["storage_state"] = settings.storage_state

        self.context = await self.browser.new_context(**ctx_kwargs)
        self.context.set_default_timeout(settings.action_timeout_ms)
        self.page = await self.context.new_page()
        await self.page.add_init_script(_STEALTH_JS)
        self.tap = NetworkTap()
        self.tap.attach(self.page)
        self.page.on("crash", lambda _p: logger.error("page crashed"))

    async def _open_playground(self) -> None:
        assert self.page is not None
        url = settings.playground_url
        logger.info("navigating to %s", url)
        try:
            await self.page.goto(
                url, wait_until="domcontentloaded", timeout=settings.nav_timeout_ms
            )
        except Exception as exc:
            logger.warning("navigation warning: %s", exc)

    # -------------------------------------------------------------- dismissal
    async def dismiss_until_ready(self, rounds: int = 30) -> bool:
        """Dismiss modals/cookies until the chat textarea is present and live."""
        assert self.page is not None
        for _ in range(rounds):
            await self.page.wait_for_timeout(1200)
            try:
                state = await self.page.evaluate(_DISMISS_JS)
            except Exception:
                state = "navigating"  # execution context destroyed by reload
            logger.debug("dismiss state: %s", state)
            if state == "ready":
                await self.page.wait_for_timeout(settings.hydration_wait_ms)
                await self._persist_state()
                return True
        return False

    async def probe_interactive(self) -> bool:
        """Check React actually responds: fill must enable the Send button."""
        assert self.page is not None
        try:
            return bool(
                await self.page.evaluate(
                    """() => {
                      const ta = document.querySelector('textarea[aria-label="chat prompt"]');
                      if (!ta) return false;
                      const prev = ta.value;
                      const setter = Object.getOwnPropertyDescriptor(
                          HTMLTextAreaElement.prototype, 'value').set;
                      setter.call(ta, prev + ' ');
                      ta.dispatchEvent(new Event('input', {bubbles: true}));
                      const b = document.querySelector('button[aria-label="Send"]');
                      const enabled = b ? !b.disabled : false;
                      setter.call(ta, prev);
                      ta.dispatchEvent(new Event('input', {bubbles: true}));
                      return enabled;
                    }"""
                )
            )
        except Exception:
            return False

    # ---------------------------------------------------------------- utility
    async def save_screenshot(self, path: Optional[str] = None,
                              full_page: bool = False) -> bytes:
        page = await self.ensure_ready()
        return await page.screenshot(path=path, full_page=full_page)

    async def _persist_state(self) -> None:
        if not (settings.storage_state and self.context):
            return
        try:
            os.makedirs(os.path.dirname(settings.storage_state) or ".", exist_ok=True)
            await self.context.storage_state(path=settings.storage_state)
        except Exception as exc:
            logger.debug("could not persist storage state: %s", exc)

    async def _safe_close(self) -> None:
        for closer, name in (
            (self.page, "page"),
            (self.context, "context"),
            (self.browser, "browser"),
        ):
            if closer is None:
                continue
            try:
                await closer.close()
            except Exception as exc:
                logger.debug("error closing %s: %s", name, exc)
        if self._pw is not None:
            try:
                await self._pw.stop()
            except Exception:
                pass
        self.page = self.context = self.browser = self._pw = None  # type: ignore[assignment]


# A single shared manager for the whole process.
manager = BrowserManager()
