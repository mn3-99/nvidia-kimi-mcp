import { z } from 'zod';
import { playgroundPage, initPlaygroundPage } from '../playground/PlaygroundPage.js';
import { browserManager } from '../browser/BrowserManager.js';
function getPage() {
    if (!playgroundPage)
        initPlaygroundPage(browserManager.getPage());
    return playgroundPage;
}
export const toolDefs = [
    {
        name: 'send_message',
        description: 'Send a message to the Kimi K3 model and optionally wait for response',
        schema: {
            message: z.string().describe('The message to send'),
            waitForResponse: z.boolean().default(true).describe('Wait for response to complete'),
            timeout: z.number().default(90).describe('Max wait time in seconds'),
        },
        handler: async (args) => {
            const page = getPage();
            await page.sendMessage(args.message);
            if (args.waitForResponse !== false) {
                const timeout = (args.timeout || 90) * 1000;
                const response = await page.waitForResponse(timeout);
                return { success: true, response };
            }
            return { success: true, message: 'Message sent' };
        },
    },
    {
        name: 'get_response',
        description: 'Get the last model response from the chat',
        schema: {},
        handler: async () => {
            const response = await getPage().getLastResponse();
            return { response };
        },
    },
    {
        name: 'screenshot',
        description: 'Take a screenshot of the current playground state',
        schema: { path: z.string().optional().describe('Save path') },
        handler: async (args) => {
            const buf = await getPage().takeScreenshot(args.path);
            return { success: true, size: buf.length };
        },
    },
];
//# sourceMappingURL=tools.js.map