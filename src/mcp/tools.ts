import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ContextEngine } from '../context/engine';
import { ReviewBroker, ReviewRequest } from '../edits/reviews';
import { Workspace } from '../workspace';

export interface ToolDeps {
  ws: Workspace;
  reviews: ReviewBroker;
  /** Called after an edit is written, so the extension can offer "Undo agent change". */
  onApplied?: (path: string, before: string | undefined, after: string) => void;
  context?: ContextEngine;
  contextBudget?: number;
  /** Called for every tool call, for the activity log. */
  onToolCall?: (name: string, args: unknown) => void;
}

const MAX_READ_LINES = 1500;

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });
const fail = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }], isError: true });

function guard<A>(deps: ToolDeps, name: string, fn: (args: A) => Promise<ToolResult>) {
  return async (args: A): Promise<ToolResult> => {
    deps.onToolCall?.(name, args);
    try {
      return await fn(args);
    } catch (e) {
      return fail(`${name} failed: ${(e as Error).message}`);
    }
  };
}

export async function prepareEdit(deps: ToolDeps, path: string, edits: { old_text: string; new_text: string }[], summary?: string): Promise<ReviewRequest> {
  const isNew = !(await deps.ws.exists(path));
  const original = isNew ? '' : await deps.ws.readFile(path);
  return deps.reviews.prepare(path, edits, original, isNew, summary);
}

export function registerTools(server: McpServer, deps: ToolDeps): void {
  const { ws } = deps;

  server.registerTool(
    'read_file',
    {
      description: 'Read a workspace file (path relative to the workspace root). Optionally pass a 1-based line range.',
      inputSchema: { path: z.string(), start_line: z.number().int().optional(), end_line: z.number().int().optional() },
      annotations: { readOnlyHint: true },
    },
    guard(deps, 'read_file', async ({ path, start_line, end_line }) => {
      const lines = (await ws.readFile(path)).split('\n');
      const start = Math.max(1, start_line ?? 1);
      const end = Math.min(lines.length, end_line ?? start + MAX_READ_LINES - 1);
      const header = `${path} (lines ${start}-${end} of ${lines.length})`;
      const more = end < lines.length ? `\n[truncated; call read_file with start_line=${end + 1} for more]` : '';
      return text(`${header}\n${lines.slice(start - 1, end).join('\n')}${more}`);
    }),
  );

  server.registerTool(
    'list_dir',
    {
      description: 'List a workspace directory. Directories end with "/".',
      inputSchema: { path: z.string().default('.') },
      annotations: { readOnlyHint: true },
    },
    guard(deps, 'list_dir', async ({ path }) => text((await ws.listDir(path)).join('\n') || '(empty)')),
  );

  server.registerTool(
    'search',
    {
      description: 'Search the workspace with ripgrep. Literal by default; set regex=true for a regular expression. Optional glob filter, e.g. "*.py".',
      inputSchema: { query: z.string(), regex: z.boolean().optional(), glob: z.string().optional(), max_results: z.number().int().optional() },
      annotations: { readOnlyHint: true },
    },
    guard(deps, 'search', async ({ query, regex, glob, max_results }) => {
      const hits = await ws.search(query, { regex, glob, maxResults: max_results ?? 50 });
      return text(hits.length ? hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join('\n') : 'No matches.');
    }),
  );

  server.registerTool(
    'find_symbol',
    {
      description: 'Find where a function, class or variable is defined.',
      inputSchema: { name: z.string() },
      annotations: { readOnlyHint: true },
    },
    guard(deps, 'find_symbol', async ({ name }) => {
      const hits = await ws.findSymbol(name);
      return text(hits.length ? hits.map((h) => `${h.kind} ${h.container ? h.container + '.' : ''}${h.name} — ${h.path}:${h.line}`).join('\n') : `No definition found for ${name}.`);
    }),
  );

  if (deps.context) {
    const engine = deps.context;
    server.registerTool(
      'get_context',
      {
        description:
          'Retrieve the most relevant files for a task description, ranked and packed into a token budget, with the reason each file was chosen. ' +
          'Supports @path and @symbol:name mentions.',
        inputSchema: { task: z.string(), budget_tokens: z.number().int().optional() },
        annotations: { readOnlyHint: true },
      },
      guard(deps, 'get_context', async ({ task, budget_tokens }) => text((await engine.build(task, budget_tokens ?? deps.contextBudget ?? 16000)).text)),
    );
  }

  server.registerTool(
    'propose_edit',
    {
      description:
        'Propose changes to ONE file as exact search/replace edits. The user reviews every hunk and may accept or reject each one; only accepted hunks are written. ' +
        'old_text must be copied exactly from the current file and match once. To create a new file, use a single edit with old_text "".',
      inputSchema: {
        path: z.string(),
        edits: z.array(z.object({ old_text: z.string(), new_text: z.string() })).min(1),
        summary: z.string().optional().describe('One line describing the change, shown to the reviewer.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guard(deps, 'propose_edit', async ({ path, edits, summary }) => {
      const req = await prepareEdit(deps, path, edits, summary);
      const accepted = deps.reviews.take(req.key);
      if (!accepted) return fail('This edit was not reviewed by the user, so nothing was written. Propose it again.');
      if (accepted.size === 0) return text(`The user rejected all ${req.hunks.length} hunk(s); ${path} is unchanged. Ask or try a different approach.`);
      const after = ReviewBroker.result(req, accepted);
      await ws.writeFile(path, after);
      deps.onApplied?.(path, req.isNew ? undefined : req.original, after);
      const rejected = req.hunks.filter((h) => !accepted.has(h.index));
      const note = rejected.length
        ? ` Rejected by the user (not written): ${rejected.map((h) => `hunk ${h.index + 1} at line ${h.originalStart + 1}`).join(', ')}.`
        : '';
      return text(`Applied ${accepted.size} of ${req.hunks.length} hunk(s) to ${path}.${note}`);
    }),
  );

  server.registerTool(
    'run_command',
    {
      description: 'Run a shell command in the workspace root (e.g. tests). The user must approve it first. Output is truncated to the last 8000 characters.',
      inputSchema: { command: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guard(deps, 'run_command', async ({ command }) => {
      const { code, output } = await ws.runCommand(command);
      return text(`exit code ${code}\n${output.slice(-8000)}`);
    }),
  );
}
