import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFileSync } from 'fs';

const EVAL_PROMPT = `You are being evaluated on your reasoning, coding, and communication abilities. Answer the following comprehensively:

1. **Reasoning**: A farmer has 17 sheep. All but 9 die. How many are left? Explain step by step.

2. **Coding**: Write a Python function that finds the longest common subsequence of two strings. Include time complexity analysis.

3. **Math**: A ball is dropped from a height of 10 meters. Each time it bounces, it reaches 3/4 of its previous height. What is the total distance traveled by the ball before it comes to rest?

4. **Logic**: You have 3 boxes. One contains only apples, one contains only oranges, and one contains both. All labels are wrong. You can pick ONE fruit from ONE box. How do you correctly label all boxes?

Provide thorough, well-structured answers with clear reasoning.`;

async function main() {
  // Start MCP server
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js'],
    stderr: 'pipe'
  });

  // Capture stderr from server
  transport.stderr?.on('data', (chunk) => {
    const msg = chunk.toString().trim();
    if (msg) console.error(`[SERVER] ${msg}`);
  });

  const client = new Client({ name: 'eval-client', version: '1.0.0' });
  await client.connect(transport);
  console.error('✓ Connected to MCP server');

  // List tools
  const { tools } = await client.listTools();
  console.error(`✓ Tools: ${tools.map(t => t.name).join(', ')}`);

  // Step 1: Screenshot initial state
  console.error('\n📸 Step 1: Initial screenshot...');
  const ss1 = await client.callTool({ name: 'screenshot', arguments: {} });
  if (ss1.content?.[0]?.data) {
    writeFileSync('/tmp/eval_01_initial.png', Buffer.from(ss1.content[0].data, 'base64'));
    console.error('   Saved: /tmp/eval_01_initial.png');
  }

  // Step 2: Try to dismiss modal by clicking
  console.error('\n🔧 Step 2: Attempting to dismiss modal...');
  const dismissResult = await client.callTool({
    name: 'send_message',
    arguments: { message: 'test', waitForResponse: false }
  });
  console.error(`   Dismiss attempt result: ${JSON.stringify(dismissResult.content?.[0]?.text?.substring(0, 200))}`);

  // Step 3: Screenshot after dismiss attempt
  console.error('\n📸 Step 3: After dismiss attempt...');
  const ss2 = await client.callTool({ name: 'screenshot', arguments: {} });
  if (ss2.content?.[0]?.data) {
    writeFileSync('/tmp/eval_02_after_dismiss.png', Buffer.from(ss2.content[0].data, 'base64'));
    console.error('   Saved: /tmp/eval_02_after_dismiss.png');
  }

  // Step 4: Send the real evaluation prompt
  console.error('\n📤 Step 4: Sending evaluation prompt...');
  const sendStart = Date.now();
  const sendResult = await client.callTool({
    name: 'send_message',
    arguments: {
      message: EVAL_PROMPT,
      waitForResponse: false
    }
  });
  const sendTime = ((Date.now() - sendStart) / 1000).toFixed(1);
  console.error(`   Send completed in ${sendTime}s`);
  console.error(`   Result: ${JSON.stringify(sendResult.content?.[0]?.text?.substring(0, 300))}`);

  // Step 5: Take screenshots every 15 seconds while waiting
  console.error('\n📸 Step 5: Monitoring thinking process...');
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 15000));
    const elapsed = ((i + 1) * 15);
    console.error(`   📸 Screenshot at ${elapsed}s...`);
    const ss = await client.callTool({ name: 'screenshot', arguments: {} });
    if (ss.content?.[0]?.data) {
      writeFileSync(`/tmp/eval_${String(i + 3).padStart(2, '0')}_${elapsed}s.png`, Buffer.from(ss.content[0].data, 'base64'));
      console.error(`   Saved: /tmp/eval_${String(i + 3).padStart(2, '0')}_${elapsed}s.png`);
    }
  }

  // Step 6: Get the full response
  console.error('\n📥 Step 6: Getting full response...');
  const responseStart = Date.now();
  const getResponseResult = await client.callTool({
    name: 'get_response',
    arguments: { timeout: 300000 }
  });
  const responseTime = ((Date.now() - responseStart) / 1000).toFixed(1);

  const responseText = getResponseResult.content?.[0]?.text || '';
  console.error(`\n✓ Response received in ${responseTime}s`);
  console.error(`  Response length: ${responseText.length} chars`);

  // Save response
  writeFileSync('/tmp/eval_response.txt', responseText);
  console.error('  Saved: /tmp/eval_response.txt');

  // Print response to stdout
  console.log(responseText);

  // Final screenshot
  console.error('\n📸 Step 7: Final screenshot...');
  const ssFinal = await client.callTool({ name: 'screenshot', arguments: {} });
  if (ssFinal.content?.[0]?.data) {
    writeFileSync('/tmp/eval_final.png', Buffer.from(ssFinal.content[0].data, 'base64'));
    console.error('   Saved: /tmp/eval_final.png');
  }

  await client.close();
  console.error('\n✓ Evaluation complete!');
}

main().catch(err => {
  console.error('Error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
