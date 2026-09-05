import type { Page } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { sessionFile } from '../browser/SessionStore.js';

const DEFAULT_PREDICT_URL = 'https://buildapi.ngc.nvidia.com/v2/predict/models/qc69jvmznzxy/kimi-k3';
// Last observed working value; refreshed from the gateway config at runtime.
const DEFAULT_FUNCTION_ID = '1586112a-925c-48af-8631-7c815dbd749c';

interface SessionCache { functionId?: string; predictUrl?: string; }
function loadCache(): SessionCache {
  try {
    if (existsSync(sessionFile())) return JSON.parse(readFileSync(sessionFile(), 'utf8'));
  } catch {}
  return {};
}
function saveCache(c: SessionCache): void {
  try { writeFileSync(sessionFile(), JSON.stringify({ ...loadCache(), ...c })); } catch {}
}

export interface ChatMessage { role: 'user' | 'assistant' | 'system'; content: string; }

/**
 * DirectClient — calls the Playground's own inference backend
 * (buildapi.ngc.nvidia.com …/v2/predict) from inside the page context,
 * so cookies / UA / TLS fingerprint all match a real browser session.
 * This is the native-like fast path: no typing, no clicking, no DOM
 * scraping — SSE tokens stream straight back like a paid endpoint.
 */
export class DirectClient {
  /** Mint a fresh invisible-hCaptcha token from the live page. */
  static async mintCaptchaToken(page: Page, timeoutMs = 25000): Promise<string> {
    const token = await page.evaluate(async (timeoutMs) => {
      const w = window as any;
      const read = (): string => {
        try {
          if (w.hcaptcha?.getResponse) {
            const t = w.hcaptcha.getResponse();
            if (t) return t;
          }
        } catch {}
        const ta = document.querySelector<HTMLTextAreaElement>('[name="h-captcha-response"]');
        return ta?.value || '';
      };
      let t = read();
      if (t) return t;
      try { await w.hcaptcha?.execute?.(); } catch {}
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        await new Promise(r => setTimeout(r, 500));
        t = read();
        if (t) return t;
      }
      return '';
    }, timeoutMs);
    if (!token) throw new Error('captcha-token-unavailable');
    return token;
  }

  /** Refresh endpoint + function id from the gateway config the UI itself uses. */
  static async discoverGateway(page: Page): Promise<{ predictUrl: string; functionId: string }> {
    const cache = loadCache();
    try {
      const found = await page.evaluate(async () => {
        const res = await fetch('https://build.nvidia.com/moonshotai/kimi-k3/playground', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(['buildapi-gateway-paths.yaml']),
        });
        const text = await res.text();
        const urlM = text.match(/https:\/\/buildapi\.ngc\.nvidia\.com\/v2\/predict\/models\/[A-Za-z0-9_-]+\/[\w.-]+/);
        const fidM = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        return { text: text.slice(0, 2000), url: urlM?.[0] || null, fid: fidM?.[0] || null };
      });
      const predictUrl = found.url || cache.predictUrl || DEFAULT_PREDICT_URL;
      const functionId = found.fid || cache.functionId || DEFAULT_FUNCTION_ID;
      saveCache({ predictUrl, functionId });
      return { predictUrl, functionId };
    } catch {
      return { predictUrl: cache.predictUrl || DEFAULT_PREDICT_URL, functionId: cache.functionId || DEFAULT_FUNCTION_ID };
    }
  }

  static async chat(
    page: Page,
    messages: ChatMessage[],
    opts: { maxTokens?: number; temperature?: number; timeoutMs?: number; onProgress?: (partial: string) => void } = {},
  ): Promise<string> {
    const { predictUrl, functionId } = await DirectClient.discoverGateway(page);
    let captcha = await DirectClient.mintCaptchaToken(page);

    const payload = {
      reasoning_effort: 'max',
      stream: true,
      model: 'moonshotai/kimi-k3',
      seed: 0,
      max_tokens: opts.maxTokens ?? 16384,
      temperature: opts.temperature ?? 1,
      messages,
      stream_options: { include_usage: true, continuous_usage_stats: true },
    };

    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await page.evaluate(async ({ url, functionId, captcha, payload, timeoutMs }) => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
          const res = await fetch(url, {
            method: 'POST',
            signal: ctrl.signal,
            headers: {
              accept: 'text/event-stream',
              'content-type': 'application/json',
              referer: 'https://build.nvidia.com/',
              'nv-function-id': functionId,
              'nv-captcha-token': captcha,
            },
            body: JSON.stringify(payload),
          });
          if (!res.ok || !res.body) return { ok: false, status: res.status, text: '' };
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = '', out = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() || '';
            for (const ln of lines) {
              const line = ln.trim();
              if (!line.startsWith('data:')) continue;
              const data = line.slice(5).trim();
              if (!data || data === '[DONE]') continue;
              try {
                const j = JSON.parse(data);
                const delta = j.choices?.[0]?.delta;
                out += delta?.content || j.choices?.[0]?.text || j.output_text || j.content || '';
              } catch { /* keep-alive comment */ }
            }
          }
          return { ok: true, status: res.status, text: out };
        } catch (e: any) {
          return { ok: false, status: 0, text: '', error: String(e?.message || e) };
        } finally {
          clearTimeout(timer);
        }
      }, { url: predictUrl, functionId, captcha, payload, timeoutMs: opts.timeoutMs ?? 300000 });

      if (result.ok && result.text) {
        opts.onProgress?.(result.text);
        return result.text;
      }
      // 401/403 => stale captcha or function id: refresh once and retry
      if ((result.status === 401 || result.status === 403) && attempt === 0) {
        console.error(`[Direct] Got ${result.status}, refreshing token+gateway and retrying…`);
        captcha = await DirectClient.mintCaptchaToken(page).catch(() => '');
        const gw = await DirectClient.discoverGateway(page).catch(() => null);
        if (gw) { (payload as any).__gw = undefined; }
        if (!captcha) break;
        // re-read fresh gateway values for retry
        const fresh = await DirectClient.discoverGateway(page);
        return DirectClient.chatWith(page, messages, fresh.predictUrl, fresh.functionId, captcha, payload, opts);
      }
      if (attempt === 0 && !result.text) {
        // Empty body (e.g. aborted WAF) — one retry with fresh token
        captcha = await DirectClient.mintCaptchaToken(page).catch(() => captcha);
        continue;
      }
      throw new Error(`direct-api-failed status=${result.status} ${(result as any).error || ''}`.trim());
    }
    throw new Error('direct-api-failed');
  }

  private static async chatWith(
    page: Page,
    messages: ChatMessage[],
    predictUrl: string,
    functionId: string,
    captcha: string,
    payload: unknown,
    opts: { timeoutMs?: number; onProgress?: (partial: string) => void },
  ): Promise<string> {
    const result = await page.evaluate(async ({ url, functionId, captcha, payload, timeoutMs }) => {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            accept: 'text/event-stream',
            'content-type': 'application/json',
            referer: 'https://build.nvidia.com/',
            'nv-function-id': functionId,
            'nv-captcha-token': captcha,
          },
          body: JSON.stringify(payload),
        });
        if (!res.ok || !res.body) return { ok: false, text: '' };
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '', out = '';
        for (;;) {
          const { done, value } = await Promise.race([
            reader.read(),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
          ]);
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() || '';
          for (const ln of lines) {
            const line = ln.trim();
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try {
              const j = JSON.parse(data);
              out += j.choices?.[0]?.delta?.content || j.choices?.[0]?.text || '';
            } catch {}
          }
        }
        return { ok: true, text: out };
      } catch { return { ok: false, text: '' }; }
    }, { url: predictUrl, functionId, captcha, payload, timeoutMs: opts.timeoutMs ?? 300000 });
    if (!result.ok || !result.text) throw new Error('direct-api-retry-failed');
    opts.onProgress?.(result.text);
    return result.text;
  }
}
