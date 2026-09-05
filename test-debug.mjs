import { chromium } from 'playwright';
import { writeFileSync } from 'fs';

async function main() {
  console.log('Starting browser...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  // Log console messages
  page.on('console', msg => console.log(`[CONSOLE] ${msg.type()}: ${msg.text()}`));

  console.log('Navigating to page...');
  await page.goto('https://build.nvidia.com/moonshotai/kimi-k3/playground', {
    waitUntil: 'networkidle',
    timeout: 60000
  });

  // Screenshot 1: Initial state
  await page.screenshot({ path: '/tmp/debug_01_initial.png', fullPage: true });
  console.log('Screenshot 1: Initial state');

  // Wait a bit
  await page.waitForTimeout(3000);

  // Screenshot 2: After wait
  await page.screenshot({ path: '/tmp/debug_02_after_wait.png', fullPage: true });
  console.log('Screenshot 2: After 3s wait');

  // Try to find the modal
  console.log('\nLooking for modal elements...');
  const modalElements = await page.evaluate(() => {
    const results = [];
    // Look for "Before You Use AI Models"
    const allText = document.body.innerText;
    if (allText.includes('Before You Use AI Models')) {
      results.push('Found "Before You Use AI Models" text');
    }
    if (allText.includes('Acknowledge & Continue')) {
      results.push('Found "Acknowledge & Continue" text');
    }
    if (allText.includes('Review Terms')) {
      results.push('Found "Review Terms" text');
    }

    // Look for buttons
    const buttons = document.querySelectorAll('button');
    results.push(`Total buttons: ${buttons.length}`);
    buttons.forEach((btn, i) => {
      const text = btn.textContent?.trim();
      if (text && text.length < 50) {
        results.push(`Button ${i}: "${text}"`);
      }
    });

    // Look for textareas
    const textareas = document.querySelectorAll('textarea');
    results.push(`Total textareas: ${textareas.length}`);
    textareas.forEach((ta, i) => {
      results.push(`Textarea ${i}: aria-label="${ta.getAttribute('aria-label')}" class="${ta.className}"`);
    });

    return results;
  });

  console.log('\nModal analysis:');
  modalElements.forEach(r => console.log(`  ${r}`));

  // Step 1: Accept cookies FIRST
  console.log('\nClicking Accept All...');
  try {
    await page.click('button:has-text("Accept All")', { force: true, timeout: 5000 });
    console.log('  Clicked!');
    await page.waitForTimeout(2000);
  } catch (e) {
    console.log(`  Error: ${e.message}`);
  }

  // Step 2: Click "Acknowledge & Continue"
  console.log('\nClicking Acknowledge & Continue...');
  try {
    await page.click('button:has-text("Acknowledge & Continue")', { force: true, timeout: 5000 });
    console.log('  Clicked!');
    await page.waitForTimeout(2000);
  } catch (e) {
    console.log(`  Error: ${e.message}`);
  }

  // Step 3: Remove overlays
  await page.evaluate(() => {
    document.querySelectorAll('[class*="backdrop"], [class*="z-40"], [class*="z-50"], [class*="overlay"]').forEach(el => {
      if (el instanceof HTMLElement) el.remove();
    });
  }).catch(() => {});

  // Screenshot 3: After both modals
  await page.screenshot({ path: '/tmp/debug_03_after_modals.png', fullPage: true });
  console.log('Screenshot 3: After both modals');

  // Check if textarea is now visible
  const textareaVisible = await page.evaluate(() => {
    const ta = document.querySelector('textarea[aria-label="chat prompt"]');
    return ta ? { visible: true, rect: ta.getBoundingClientRect() } : { visible: false };
  });
  console.log(`\nTextarea visible: ${JSON.stringify(textareaVisible)}`);

  await browser.close();
  console.log('\nDone!');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
