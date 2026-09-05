import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFileSync } from 'fs';

const EVAL_PROMPT = `Evaluate these four areas thoroughly:

1) REASONING: A farmer has 17 sheep. All but 9 die. How many sheep remain? Show your reasoning.

2) CODING: Write a Python function to find the longest common subsequence of two strings. Analyze time complexity.

3) MATH: A ball drops from 10m. Each bounce reaches 3/4 previous height. Calculate total distance traveled before rest.

4) LOGIC: Three boxes: apples, oranges, mixed. All labels wrong. Pick ONE fruit from ONE box to correctly label all. Explain the strategy.`;

async function main() {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js'],
    stderr: 'pipe'
  });
  transport.stderr?.on('data', (chunk) => {
    const msg = chunk.toString().trim();
    if (msg) console.error(`[SRV] ${msg}`);
  });

  const client = new Client({ name: 'eval-client', version: '1.0.0' });
  await client.connect(transport);
  console.error('Connected');

  const { tools } = await client.listTools();
  console.error(`Tools: ${tools.map(t => t.name).join(', ')}`);

  // Screenshot initial
  const ss1 = await client.callTool({ name: 'screenshot', arguments: {} });
  if (ss1.content?.[0]?.text) {
    const r = JSON.parse(ss1.content[0].text);
    if (r.data) writeFileSync('/tmp/mcp_01_initial.png', Buffer.from(r.data, 'base64'));
  }

  // Send message
  console.error('\nSending evaluation prompt...');
  const sendResult = await client.callTool({
    name: 'send_message',
    arguments: { message: EVAL_PROMPT, waitForResponse: false }
  });
  console.error(`Send: ${sendResult.content?.[0]?.text?.substring(0, 100)}`);

  // Wait and screenshot
  for (let i = 1; i <= 20; i++) {
    await new Promise(r => setTimeout(r, 15000));
    const ss = await client.callTool({ name: 'screenshot', arguments: {} });
    if (ss.content?.[0]?.text) {
      const r = JSON.parse(ss.content[0].text);
      if (r.data) writeFileSync(`/tmp/mcp_${String(i+1).padStart(2,'0')}_${i*15}s.png`, Buffer.from(r.data, 'base64'));
    }
    console.error(`${i*15}s screenshot taken`);
  }

  // Get response
  console.error('\nGetting response...');
  const response = await client.callTool({ name: 'get_response', arguments: {} });
  const text = response.content?.[0]?.text || '';
  console.error(`Response: ${text.length} chars`);
  writeFileSync('/tmp/mcp_response.txt', text);
  console.log(text);

  await client.close();
  console.error('Done');
}

main().catch(e => { console.error(e.message); process.exit(1); });
