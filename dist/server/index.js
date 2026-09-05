import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { browserManager } from '../browser/BrowserManager.js';
import { toolDefs } from '../tools/tools.js';
const log = (...args) => console.error('[MCP]', ...args);
const server = new McpServer({
    name: 'nvidia-kimi-mcp',
    version: '1.0.0',
});
for (const def of toolDefs) {
    server.tool(def.name, def.description, def.schema, async (args) => {
        try {
            console.error(`[MCP] Calling tool: ${def.name}`);
            const result = await def.handler(args);
            console.error(`[MCP] Tool ${def.name} completed`);
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }
        catch (error) {
            console.error(`[MCP] Tool ${def.name} error:`, error);
            return {
                content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
                isError: true,
            };
        }
    });
}
export async function main() {
    log('Initializing browser...');
    await browserManager.initialize();
    log('Browser ready');
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log('Server connected via stdio');
    process.on('SIGINT', async () => { await browserManager.close(); process.exit(0); });
    process.on('SIGTERM', async () => { await browserManager.close(); process.exit(0); });
}
//# sourceMappingURL=index.js.map