import { BrowserManager } from './browser/BrowserManager.js';
import { initPlaygroundPage } from './playground/PlaygroundPage.js';
async function test() {
    console.log('Testing browser initialization...');
    const manager = new BrowserManager(true);
    const page = await manager.initialize();
    console.log('Browser initialized');
    const pg = initPlaygroundPage(page);
    console.log('Testing selector discovery...');
    const selectors = await pg.discoverSelectors();
    console.log('Discovered selectors:', JSON.stringify(selectors, null, 2));
    console.log('Testing get config...');
    const config = await pg.getConfig();
    console.log('Current config:', JSON.stringify(config, null, 2));
    console.log('Testing model listing...');
    try {
        const models = await pg.getAvailableModels();
        console.log('Available models:', JSON.stringify(models, null, 2));
    }
    catch (e) {
        console.log('Could not list models:', e);
    }
    console.log('Testing send message...');
    try {
        await pg.sendMessage('Hello, this is a test message');
        await pg.waitForResponse(30000);
        const response = await pg.getLastResponse();
        console.log('Response:', response);
    }
    catch (e) {
        console.log('Could not send message:', e);
    }
    console.log('Testing screenshot...');
    const screenshot = await pg.takeScreenshot('/tmp/test-screenshot.png');
    console.log('Screenshot size:', screenshot.length);
    await manager.close();
    console.log('Test completed');
}
test().catch(console.error);
//# sourceMappingURL=test.js.map