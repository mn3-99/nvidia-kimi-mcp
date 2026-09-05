import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const PROMPT = `اكتب برومبت احترافي لعمل كود بحث عميق في GitHub بحيث يبحث عن أكواد داخل المشاريع في جيت هب والبحث في آلاف المشاريع بتقنيات وطرق بحث ذكية ومختلفة وتتوافق مع جيت هب.

المطلوب: برومبت جاهز يُعطى لأي نموذج ذكاء اصطناعي ليولّد كوداً متكاملاً لأداة بحث عميق في GitHub تشمل: البحث في محتوى الأكواد داخل آلاف المستودعات، استخدام GitHub Code Search API وSearch API، تقنيات بحث ذكية (فلاتر اللغة والنجوم والتاريخ والحجم، بحث بالـ regex والـ symbols، بحث في الـ issues والـ PRs والـ commits)، التعامل مع rate limits والـ pagination والـ parallel requests، وطرق مختلفة للبحث (keyword, semantic, dependency-based). اكتب البرومبت بالعربية مع المصطلحات التقنية بالإنجليزية.`;

async function main() {
  const transport = new StdioClientTransport({ command: 'node', args: ['dist/index.js'], stderr: 'pipe' });
  transport.stderr?.on('data', c => process.stderr.write(c.toString()));
  const client = new Client({ name: 't', version: '1.0.0' });
  await client.connect(transport);
  console.error('\n=== بدء البث المباشر ===\n');
  
  // استخدم send_message مع mode=direct للاستفادة من onProgress
  const result = await client.callTool({
    name: 'send_message',
    arguments: { 
      message: PROMPT, 
      mode: 'direct', 
      waitForResponse: true, 
      timeout: 420 
    }
  }, undefined, { timeout: 480000 });
  
  console.error('\n=== انتهى البث ===');
  const text = JSON.parse(result.content?.[0]?.text || '{}').response || result.content?.[0]?.text;
  console.log('\n--- الإجابة النهائية ---\n');
  console.log(text);
  await client.close();
}
main().catch(e => { console.error('FATAL', e.message); process.exit(1); });