// Headless end-to-end driver: same MCP server + runner the extension uses, auto-accepting every hunk.
// Usage: node out/test/headless.js <workspace> "<prompt>" [model,...]
import { TrueForge } from '@truefoundry/trueforge-sdk';
import { ContextEngine } from '../src/context/engine';
import { ReviewBroker } from '../src/edits/reviews';
import { prepareEdit, ToolDeps } from '../src/mcp/tools';
import { startMcpServer } from '../src/mcp/server';
import { registerMcpServer } from '../src/trueforge/register';
import { AgentRunner } from '../src/trueforge/runner';
import { describeWorkspace, Workspace } from '../src/workspace';

const [root, prompt, models = 'google-gemini/gemini-3-5-flash,groq/qwen3-8-27b'] = process.argv.slice(2);
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

const ws = new Workspace(root);
const deps: ToolDeps = { ws, reviews: new ReviewBroker(), context: new ContextEngine(ws), contextBudget: 12000, onToolCall: (n, a) => log('MCP', n, JSON.stringify(a).slice(0, 120)) };
const mcp = await startMcpServer(deps, 0);
const client = new TrueForge({ baseUrl: process.env.TRUEFORGE_URL ?? 'http://localhost:8790', timeoutInSeconds: 900 });
await registerMcpServer(client, mcp.url, mcp.token);
let streamed = 0;
const runner = new AgentRunner(client, { models: models.split(','), workspaceNotes: await describeWorkspace(deps.ws) }, {
  onEvent: (e) => {
    if (e.type === 'delta') return void (streamed += e.text.length);
    if (e.type === 'message') log('MODEL', e.model ?? '', e.text.slice(0, 200).replace(/\n/g, ' '), e.toolCalls.map((t) => t.name).join(','));
    else if (e.type === 'tool') log('TOOL←', e.result.slice(0, 100).replace(/\n/g, ' '));
    else log(e.type.toUpperCase(), JSON.stringify(e));
  },
  decide: async (pending) => {
    const out = [];
    for (const p of pending) {
      if (p.name === 'propose_edit') {
        const a = p.args as any;
        try {
          const req = await prepareEdit(deps, a.path, a.edits, a.summary);
          log('REVIEW', a.path, `${req.hunks.length} hunk(s) → accept all`);
          deps.reviews.record(req.key, req.hunks.map((h) => h.index));
          out.push({ threadId: p.threadId, toolCallId: p.toolCallId, allow: true });
        } catch (e) {
          out.push({ threadId: p.threadId, toolCallId: p.toolCallId, allow: false, reason: (e as Error).message });
        }
      } else {
        log('APPROVE', p.name, JSON.stringify(p.args).slice(0, 120));
        out.push({ threadId: p.threadId, toolCallId: p.toolCallId, allow: true });
      }
    }
    return out;
  },
});
const pack = await deps.context!.build(prompt, 12000);
log('CONTEXT', `${pack.used}/${pack.budget} tok`, pack.items.map((i) => `${i.path}(${i.mode})`).join(' '));
await runner.send(`${prompt}\n\n${pack.text}`);
log('streamed chars:', streamed);
await mcp.close();
