import { chromium } from 'playwright';
import { writeFileSync } from 'fs';

async function dismissAllOverlays(page) {
  // Remove cookie consent + AI modal + all overlays via DOM removal
  await page.evaluate(() => {
    // Remove ALL overlay/modal elements by z-index and class
    document.querySelectorAll('[class*="cookie"], [class*="consent"], [id*="onetrust"], [class*="onetrust"]').forEach(el => el.remove());
    document.querySelectorAll('[class*="backdrop"], [class*="z-40"], [class*="z-50"]').forEach(el => el.remove());
    document.querySelectorAll('[class*="overlay"], [class*="modal"]').forEach(el => {
      if (el instanceof HTMLElement && el.style.position === 'fixed' || el.style.position === 'absolute') el.remove();
    });
    // Click any accept buttons
    document.querySelectorAll('button').forEach(btn => {
      const text = btn.textContent?.trim().toLowerCase();
      if (text === 'accept all' || text === 'save and accept' || text?.includes('acknowledge')) {
        btn.click();
      }
    });
  }).catch(() => {});
  await page.waitForTimeout(1000);
}

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  console.log('1. Navigating...');
  await page.goto('https://build.nvidia.com/moonshotai/kimi-k3/playground', {
    waitUntil: 'networkidle', timeout: 60000
  });

  // Phase 1: Dismiss cookies
  console.log('2. Accepting cookies via native click...');
  const acceptCoords = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const btn = btns.find(b => b.textContent?.trim() === 'Accept All');
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: r.x + r.width/2, y: r.y + r.height/2 };
  });
  if (acceptCoords) {
    await page.mouse.click(acceptCoords.x, acceptCoords.y);
    console.log('   Clicked Accept All');
  }
  await page.waitForTimeout(2000);

  // Phase 2: Dismiss AI modal
  console.log('3. Acknowledging AI modal via native click...');
  const ackCoords = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const btn = btns.find(b => b.textContent?.includes('Acknowledge & Continue'));
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: r.x + r.width/2, y: r.y + r.height/2 };
  });
  if (ackCoords) {
    await page.mouse.click(ackCoords.x, ackCoords.y);
    console.log('   Clicked Acknowledge & Continue');
  }
  await page.waitForTimeout(5000);
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(3000);

  // Phase 3: Remove any leftover overlays
  await dismissAllOverlays(page);
  console.log('4. Overlays cleared');
  await page.screenshot({ path: '/tmp/final_01_clean.png' });

  // Phase 4: Type message - wait for textarea with retries
  let ta;
  for (let attempt = 0; attempt < 5; attempt++) {
    await dismissAllOverlays(page);
    ta = page.locator('textarea[aria-label="chat prompt"]');
    try {
      await ta.waitFor({ state: 'visible', timeout: 5000 });
      break;
    } catch {
      console.log(`   Textarea not found, retry ${attempt+1}...`);
      await page.waitForTimeout(2000);
    }
  }
  await ta.click({ force: true });

  const prompt = `Evaluate these four areas thoroughly:

1) REASONING: A farmer has 17 sheep. All but 9 die. How many sheep remain? Show your reasoning.

2) CODING: Write a Python function to find the longest common subsequence of two strings. Analyze time complexity.

3) MATH: A ball drops from 10m. Each bounce reaches 3/4 previous height. Calculate total distance traveled before rest.

4) LOGIC: Three boxes: apples, oranges, mixed. All labels wrong. Pick ONE fruit from ONE box to correctly label all. Explain the strategy.`;

  await page.evaluate((text) => {
    const ta = document.querySelector('textarea[aria-label="chat prompt"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(ta, text);
    else ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
  }, prompt);
  await page.waitForTimeout(1000);

  const sendOk = await page.evaluate(() => {
    const btn = document.querySelector('button[aria-label="Send"]');
    return btn ? !btn.disabled : false;
  });
  console.log(`5. Message typed, send enabled: ${sendOk}`);

  // Phase 5: Send
  if (sendOk) {
    const sendCoords = await page.evaluate(() => {
      const btn = document.querySelector('button[aria-label="Send"]');
      const r = btn.getBoundingClientRect();
      return { x: r.x + r.width/2, y: r.y + r.height/2 };
    });
    await page.mouse.click(sendCoords.x, sendCoords.y);
    console.log('6. Message sent!');
  }
  await page.waitForTimeout(3000);

  // Phase 6: Dismiss overlays again (cookie consent may reappear)
  await dismissAllOverlays(page);
  await page.screenshot({ path: '/tmp/final_02_sent.png' });

  // Phase 7: Monitor response
  let responseText = '';
  for (let i = 1; i <= 20; i++) {
    await page.waitForTimeout(15000);
    const elapsed = i * 15;
    
    // Dismiss any reappearing overlays
    await dismissAllOverlays(page);
    
    await page.screenshot({ path: `/tmp/final_${String(i+2).padStart(2,'0')}_${elapsed}s.png` });

    // Extract response
    responseText = await page.evaluate(() => {
      // Method 1: Look for rendered markdown in the LAST response block
      const mdBlocks = document.querySelectorAll('.markdown-body, .prose, [class*="response-content"], [class*="message-content"]');
      let lastResponse = '';
      for (const md of mdBlocks) {
        const t = md.innerText?.trim();
        if (t && t.length > 200 && !t.includes('GOVERNING') && !t.includes('Accept All') && !t.includes('please do not upload')) {
          lastResponse = t; // keep updating to get the last one
        }
      }
      if (lastResponse) return lastResponse;
      
      // Method 2: Look for text blocks after the user message that are substantial
      const allBlocks = document.querySelectorAll('div, p, span');
      let foundUserMsg = false;
      for (const block of allBlocks) {
        const t = block.innerText?.trim();
        if (t?.includes('Evaluate these four')) { foundUserMsg = true; continue; }
        if (foundUserMsg && t && t.length > 200 && !t.includes('GOVERNING') && !t.includes('Accept All') && !t.includes('please do not upload') && !t.includes('Refine your idea')) {
          return t;
        }
      }
      return '';
    });

    const streaming = await page.evaluate(() => {
      // Check for loading indicators (animated bars, spinners)
      const loadingBars = document.querySelectorAll('[class*="loading"], [class*="spinner"], [class*="thinking"]');
      if (loadingBars.length > 0) return true;
      // Check for stop button  
      for (const b of document.querySelectorAll('button')) {
        const l = (b.getAttribute('aria-label') || '').toLowerCase();
        if (l.includes('stop') || l.includes('إيقاف') || l.includes('cancel')) return true;
      }
      return false;
    });

    // Check if gray loading bars are visible (thinking indicator)
    const hasLoadingBars = await page.evaluate(() => {
      const bars = document.querySelectorAll('[class*="nv-streaming"], [class*="streaming"], [class*="loading-bar"], [class*="skeleton"]');
      return bars.length > 0;
    });

    console.log(`7. ${elapsed}s - streaming: ${streaming}, loadingBars: ${hasLoadingBars}, response: ${responseText.length} chars`);
    if (responseText.length > 200 && !streaming && !hasLoadingBars && i > 4) break;
  }

  writeFileSync('/tmp/final_response.txt', responseText || 'NO RESPONSE');
  console.log(`\n8. Final response: ${(responseText||'').length} chars`);
  console.log(responseText?.substring(0, 1000) || 'NO RESPONSE');

  await page.screenshot({ path: '/tmp/final_done.png' });
  await browser.close();
  console.log('DONE');
}

main().catch(e => { console.error(e.message); process.exit(1); });
