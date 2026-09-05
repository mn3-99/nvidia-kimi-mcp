import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
async function main() {
  const transport = new StdioClientTransport({ command: 'node', args: ['dist/index.js'], stderr: 'pipe' });
  transport.stderr?.on('data', c => process.stderr.write('[SRV] ' + c.toString()));
  const client = new Client({ name: 't', version: '1.0.0' });
  await client.connect(transport);
  const t0 = Date.now();
  const r = await client.callTool({ name: 'send_message', arguments: { message: 'Reply with exactly: DIRECT_OK', mode: 'direct', waitForResponse: true, timeout: 180 } });
  console.log('ELAPSED_S:', ((Date.now() - t0) / 1000).toFixed(1));
  console.log('RESULT:', r.content?.[0]?.text?.slice(0, 500));
  await client.close();
}
main().catch(e => { console.error('FATAL', e.message); process.exit(1); });
