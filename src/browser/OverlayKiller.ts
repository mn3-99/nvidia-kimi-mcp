/**
 * OverlayKiller — injected at document_start (before React/modals render).
 * Pre-seeds consent flags + MutationObserver that removes consent/backdrop
 * blockers the moment they are inserted, and clicks accept/acknowledge
 * while they are still unattached (no overlay interception possible).
 */
export const OVERLAY_KILLER_SOURCE = `
(() => {
  try {
    // Pre-seed OneTrust consent so the banner often never renders
    const future = new Date(Date.now() + 365*24*3600*1000).toUTCString();
    document.cookie = 'OptanonAlertBoxClosed=' + future + '; path=/;';
    try {
      localStorage.setItem('OptanonAlertBoxClosed', future);
      localStorage.setItem('ai-disclaimer-acknowledged', 'true');
    } catch {}
  } catch {}

  const KILL_RE = /onetrust|cookie|consent|backdrop|qc69jvmznzxy/i;
  const CLICK_RE = /^(accept all|save and accept|acknowledge(&| and)? continue|reject optional)$/i;

  function scrub(root) {
    try {
      // Click consent buttons while cheap (before they paint over content)
      const btns = (root.querySelectorAll ? root.querySelectorAll('button') : []);
      for (const b of btns) {
        const t = (b.textContent || '').trim().toLowerCase().replace(/\\s+/g, ' ');
        if (CLICK_RE.test(t)) { try { b.click(); } catch {} }
      }
      // Remove fixed/absolute full-screen blockers only (never chat content)
      const all = root.querySelectorAll ? root.querySelectorAll('div,section,aside') : [];
      for (const el of all) {
        const cls = (el.className && el.className.baseVal !== undefined ? '' : String(el.className || ''));
        const id = String(el.id || '');
        if (!KILL_RE.test(cls + ' ' + id)) continue;
        const pos = getComputedStyle(el).position;
        if (pos === 'fixed' || pos === 'absolute') {
          const r = el.getBoundingClientRect();
          if (r.width > innerWidth * 0.5 && r.height > innerHeight * 0.3) el.remove();
        }
      }
    } catch {}
  }

  new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) {
      if (n.nodeType === 1) scrub(n);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
`;
