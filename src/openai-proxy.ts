import { createServer } from 'http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const API_KEY = process.env.API_KEY || 'kimi-k3-local-key';
const MODEL_NAME = 'moonshotai/kimi-k3';
const MCP_CMD = ['node', 'dist/index.js'];
const PORT = Number(process.env.PORT) || 3001;

let mcpClient: Client | null = null;
let mcpTransport: StdioClientTransport | null = null;

async function getMcpClient(): Promise<Client> {
  if (mcpClient) return mcpClient;
  console.error('[Proxy] Starting MCP client...');
  mcpTransport = new StdioClientTransport({ command: MCP_CMD[0], args: MCP_CMD.slice(1), stderr: 'pipe' });
  mcpTransport.stderr?.on('data', c => process.stderr.write('[MCP] ' + c.toString()));
  mcpClient = new Client({ name: 'openai-proxy', version: '1.0.0' });
  await mcpClient.connect(mcpTransport);
  console.error('[Proxy] MCP client ready');
  return mcpClient;
}

function parseBody(req: any): Promise<any> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: Buffer) => body += chunk);
    req.on('end', () => resolve(body ? JSON.parse(body) : {}));
  });
}

function sendJson(res: any, status: number, data: any) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sendSSE(res: any, data: any) {
  if (data === '[DONE]') {
    res.write('data: [DONE]\n\n');
  } else {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}

const server = createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();

  // Auth
  if (req.url?.startsWith('/v1/')) {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ') || auth.slice(7) !== API_KEY) {
      return sendJson(res, 401, { error: { message: 'Invalid API key', type: 'auth_error' } });
    }
  }

  try {
    if (req.url === '/health' && req.method === 'GET') {
      return sendJson(res, 200, { status: 'ok', model: MODEL_NAME });
    }

    if (req.url === '/v1/models' && req.method === 'GET') {
      return sendJson(res, 200, {
        object: 'list',
        data: [{ id: MODEL_NAME, object: 'model', created: Date.now(), owned_by: 'nvidia' }]
      });
    }

    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      console.error('[Proxy] Received chat completion request');
      const body = await parseBody(req);
      console.error('[Proxy] Request body parsed');
      const { messages, stream = false, max_tokens, temperature = 1 } = body;
      if (!messages?.length) return sendJson(res, 400, { error: { message: 'messages required', type: 'invalid_request_error' } });

      const userMsg = messages.filter((m: any) => m.role === 'user').map((m: any) => m.content).join('\n\n');
      const systemMsg = messages.filter((m: any) => m.role === 'system').map((m: any) => m.content).join('\n\n');
      const prompt = systemMsg ? `${systemMsg}\n\n${userMsg}` : userMsg;

      console.error('[Proxy] Getting MCP client...');
      const client = await getMcpClient();
      console.error('[Proxy] Got MCP client, calling tool...');
      const result = await client.callTool({
        name: 'send_message',
        arguments: { message: prompt, mode: 'direct', waitForResponse: true, timeout: 420 }
      }, undefined, { timeout: 480000 }) as { content: Array<{ type: 'text'; text: string }> };
      console.error('[Proxy] Tool call completed');
      const text = JSON.parse(result.content[0]?.text || '{}').response || result.content[0]?.text || '';

      if (stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        try {
          // Simulate streaming by chunking
          const chunks = text.match(/.{1,80}/g) || [text];
          for (const chunk of chunks) {
            sendSSE(res, {
              id: `chatcmpl-${Date.now()}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: MODEL_NAME,
              choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }]
            });
            await new Promise(r => setTimeout(r, 30));
          }
          sendSSE(res, '[DONE]');
        } catch (e: any) {
          console.error('[Proxy] Streaming error:', e);
          sendSSE(res, { error: { message: e.message, type: 'server_error' } });
        } finally {
          return res.end();
        }
      }

      return sendJson(res, 200, {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: MODEL_NAME,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: Math.ceil(prompt.length / 4), completion_tokens: Math.ceil(text.length / 4), total_tokens: Math.ceil((prompt.length + text.length) / 4) }
      });
    }

    sendJson(res, 404, { error: { message: 'Not found', type: 'not_found' } });
  } catch (e: any) {
    sendJson(res, 500, { error: { message: e.message, type: 'server_error' } });
  }
});

server.listen(PORT, () => {
  console.error(`🚀 OpenAI-compatible proxy listening on http://localhost:${PORT}`);
  console.error(`   API Key: ${API_KEY}`);
  console.error(`   Model: ${MODEL_NAME}`);
  console.error(`   Endpoints: GET /v1/models, POST /v1/chat/completions (stream & non-stream)`);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Proxy] Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Proxy] Uncaught exception:', err);
});
process.on('SIGINT', async () => {
  if (mcpTransport) await mcpTransport.close();
  server.close();
  process.exit(0);
});