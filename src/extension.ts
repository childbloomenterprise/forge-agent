import * as vscode from 'vscode';
import { TrueForge } from '@truefoundry/trueforge-sdk';
import { ContextEngine } from './context/engine';
import { ReviewBroker, ReviewRequest } from './edits/reviews';
import { ReviewUi } from './edits/reviewUi';
import { startMcpServer, RunningMcpServer } from './mcp/server';
import { prepareEdit, ToolDeps } from './mcp/tools';
import { AgentPanel, PanelInbound } from './panel/AgentPanel';
import { registerMcpServer } from './trueforge/register';
import { AgentRunner, PendingApproval, UiEvent } from './trueforge/runner';
import { VsCodeWorkspace } from './vscodeWorkspace';
import { describeWorkspace } from './workspace';

const START_HINT = `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]' npx @truefoundry/trueforge@latest`;

interface AppliedChange {
  path: string;
  before: string | undefined;
  after: string;
}

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const panel = new AgentPanel(ctx.extensionUri);
  const out = vscode.window.createOutputChannel('Forge Agent');
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AgentPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } }),
    out,
  );

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    panel.post({ type: 'status', level: 'error', text: 'Open a folder to use Forge Agent.' });
    return;
  }

  const cfg = vscode.workspace.getConfiguration('forgeAgent');
  const ws = new VsCodeWorkspace(folder.uri.fsPath);
  const reviews = new ReviewBroker();
  const applied: AppliedChange[] = [];
  const reviewUi = new ReviewUi();
  ctx.subscriptions.push(reviewUi.register());

  const context = new ContextEngine(ws);
  const budget = () => vscode.workspace.getConfiguration('forgeAgent').get<number>('contextBudgetTokens', 16000);
  const deps: ToolDeps = {
    ws,
    reviews,
    context,
    contextBudget: budget(),
    onApplied: (path, before, after) => applied.push({ path, before, after }),
    onToolCall: (name, args) => out.appendLine(`[mcp] ${name} ${JSON.stringify(args).slice(0, 300)}`),
  };

  let mcp: RunningMcpServer;
  try {
    mcp = await startMcpServer(deps, cfg.get<number>('mcpPort', 9317));
  } catch {
    mcp = await startMcpServer(deps, 0);
  }
  ctx.subscriptions.push({ dispose: () => void mcp.close() });
  out.appendLine(`[mcp] listening on ${mcp.url}`);

  const client = new TrueForge({ baseUrl: cfg.get<string>('trueforgeUrl', 'http://localhost:8790'), timeoutInSeconds: 900 });
  let registered = false;
  const ensureRegistered = async () => {
    if (registered) return;
    await registerMcpServer(client, mcp.url, mcp.token);
    registered = true;
  };

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'forgeAgent.focus';
  ctx.subscriptions.push(status);
  const showModel = (name: string) => {
    status.text = `$(tools) Forge: ${name}`;
    status.show();
    panel.post({ type: 'model', text: name });
  };

  const waiting = new Map<string, (m: Extract<PanelInbound, { type: 'decision' }>) => void>();
  let seq = 0;
  const ask = <T>(message: object, signal: AbortSignal, map: (m: Extract<PanelInbound, { type: 'decision' }>) => T, onAbort: T): Promise<T> =>
    new Promise((resolve) => {
      const id = `d${++seq}`;
      if (signal.aborted) return resolve(onAbort);
      waiting.set(id, (m) => resolve(map(m)));
      signal.addEventListener('abort', () => (waiting.delete(id), resolve(onAbort)), { once: true });
      panel.post({ ...message, id });
    });

  const decide = async (pending: PendingApproval[], signal: AbortSignal) =>
    Promise.all(
      pending.map(async (p) => {
        const base = { threadId: p.threadId, toolCallId: p.toolCallId };
        if (p.name === 'propose_edit') {
          const a = p.args as { path?: string; edits?: { old_text: string; new_text: string }[]; summary?: string };
          let req: ReviewRequest;
          try {
            req = await prepareEdit(deps, String(a.path), a.edits ?? [], a.summary);
          } catch (e) {
            panel.post({ type: 'status', level: 'info', text: `Edit to ${a.path} could not be applied (${(e as Error).message}); asking the model to fix it.` });
            return { ...base, allow: false, reason: (e as Error).message };
          }
          if (req.hunks.length === 0) return { ...base, allow: false, reason: 'The edit makes no change to the file.' };
          const id = `d${++seq}`;
          waiting.set(id, (m) => reviewUi.resolveExternally(id, m.accepted ?? []));
          panel.post({
            type: 'review',
            id,
            path: req.path,
            isNew: req.isNew,
            summary: req.summary,
            hunks: req.hunks.map((h) => ({ index: h.index, start: h.originalStart, removed: h.removed, added: h.added })),
          });
          const accepted = await reviewUi.show(id, req, (rel) => ws.uri(rel), signal);
          waiting.delete(id);
          panel.post({ type: 'reviewDone', id, accepted, total: req.hunks.length });
          if (accepted.length === 0) return { ...base, allow: false, reason: `The user rejected every hunk of the edit to ${req.path}.` };
          reviews.record(req.key, accepted);
          return { ...base, allow: true };
        }
        const detail = p.name === 'run_command' ? String((p.args as { command?: string }).command) : JSON.stringify(p.args, null, 2);
        const allow = await ask({ type: 'approve', name: p.name, detail }, signal, (m) => m.allow === true, false);
        return { ...base, allow, reason: allow ? undefined : 'The user denied this tool call.' };
      }),
    );

  const preview = (name: string, args: string): string => {
    try {
      const a = JSON.parse(args || '{}');
      return String(a.path ?? a.query ?? a.name ?? a.command ?? '').slice(0, 80);
    } catch {
      return '';
    }
  };

  const onEvent = (e: UiEvent) => {
    switch (e.type) {
      case 'message':
        panel.post({ ...e, toolCalls: e.toolCalls.map((t) => ({ ...t, preview: preview(t.name, t.args) })) });
        break;
      case 'model':
        showModel(e.name);
        break;
      case 'turn':
        void vscode.commands.executeCommand('setContext', 'forgeAgent.running', e.status === 'running');
        panel.post({ type: 'running', value: e.status === 'running' });
        if (e.status === 'error') panel.post({ type: 'status', level: 'error', text: `Turn failed: ${e.message}. No unreviewed edits were written.` });
        if (e.status === 'cancelled') {
          reviews.clear();
          panel.post({ type: 'status', level: 'info', text: 'Cancelled. Pending proposals were discarded; nothing unreviewed was written.' });
        }
        break;
      default:
        panel.post(e);
    }
  };

  const runner = new AgentRunner(client, { models: cfg.get<string[]>('models', []), workspaceNotes: await describeWorkspace(ws) }, { onEvent, decide });
  const inlineRunner = new AgentRunner(
    client,
    { models: cfg.get<string[]>('models', []), workspaceNotes: await describeWorkspace(ws), iterationLimit: 10 },
    { onEvent, decide },
  );
  showModel(runner.model);

  const inlineEdit = async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') return void vscode.window.showInformationMessage('Forge Agent: open a file to edit inline.');
    if (runner.running || inlineRunner.running) return void vscode.window.showWarningMessage('Forge Agent: a turn is already running.');
    const doc = editor.document;
    const rel = ws.relative(doc.uri.fsPath);
    const range = editor.selection.isEmpty ? await enclosingRange(doc, editor.selection.active) : new vscode.Range(editor.selection.start.line, 0, editor.selection.end.line, doc.lineAt(editor.selection.end.line).text.length);
    editor.selection = new vscode.Selection(range.start, range.end);
    const where = `${rel}:${range.start.line + 1}-${range.end.line + 1}`;
    const instruction = await vscode.window.showInputBox({ title: `Forge inline edit — ${where}`, prompt: 'Describe the change', ignoreFocusOut: true });
    if (!instruction) return;
    try {
      await ensureRegistered();
    } catch (e) {
      return void panel.post({ type: 'status', level: 'error', text: `TrueForge is not reachable (${(e as Error).message}). Start it with: ${START_HINT}` });
    }
    panel.post({ type: 'user', text: `Inline edit ${where}: ${instruction}` });
    const pack = await context.build(`${instruction} @${rel}`, Math.min(4000, budget())).catch(() => undefined);
    if (pack) panel.post({ type: 'context', items: pack.items, used: pack.used, budget: pack.budget, keywords: pack.keywords });
    const content =
      `Inline edit in ${rel}, lines ${range.start.line + 1}-${range.end.line + 1}.\nInstruction: ${instruction}\n\n` +
      `Selected code:\n\`\`\`\n${doc.getText(range)}\n\`\`\`\n` +
      `Make the change with one propose_edit call on ${rel}, copying old_text exactly from the selected code. ` +
      `Keep the edit inside the selection unless the instruction requires more. Do not run commands.` +
      (pack ? `\n\n${pack.text}` : '');
    inlineRunner.reset();
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Forge inline edit: ${where}`, cancellable: true },
      async (_progress, token) => {
        token.onCancellationRequested(() => void cancel());
        await inlineRunner.send(content);
      },
    );
  };

  const send = async (text: string) => {
    panel.post({ type: 'user', text });
    try {
      await ensureRegistered();
    } catch (e) {
      panel.post({ type: 'status', level: 'error', text: `TrueForge is not reachable at ${cfg.get('trueforgeUrl')} (${(e as Error).message}). Start it with: ${START_HINT}` });
      return;
    }
    let content = text;
    try {
      const pack = await context.build(text, budget());
      panel.post({ type: 'context', items: pack.items, used: pack.used, budget: pack.budget, keywords: pack.keywords });
      out.appendLine(`[context] ${pack.items.map((i) => `${i.path}:${i.mode}:${i.tokens}`).join(' ')}`);
      if (pack.items.length) content = `${text}\n\n${pack.text}`;
    } catch (e) {
      panel.post({ type: 'status', level: 'warn', text: `Context retrieval failed (${(e as Error).message}); the agent will search on its own.` });
    }
    await runner.send(content);
  };

  const newSession = () => {
    if (runner.running) return void vscode.window.showWarningMessage('Forge Agent: cancel the running turn first.');
    runner.reset();
    showModel(runner.model);
    panel.post({ type: 'clear' });
  };

  const cancel = async () => {
    for (const resolve of waiting.values()) resolve({ type: 'decision', id: '', accepted: [], allow: false });
    waiting.clear();
    await Promise.all([runner.cancel(), inlineRunner.cancel()]);
  };

  ctx.subscriptions.push(
    panel.onMessage((m) => {
      if (m.type === 'send') void send(m.text);
      else if (m.type === 'cancel') void cancel();
      else if (m.type === 'newSession') newSession();
      else if (m.type === 'decision') {
        waiting.get(m.id)?.(m);
        waiting.delete(m.id);
      }
    }),
    vscode.commands.registerCommand('forgeAgent.focus', () => vscode.commands.executeCommand(`${AgentPanel.viewId}.focus`)),
    vscode.commands.registerCommand('forgeAgent.cancel', cancel),
    vscode.commands.registerCommand('forgeAgent.inlineEdit', inlineEdit),
    vscode.commands.registerCommand('forgeAgent.newSession', newSession),
    vscode.commands.registerCommand('forgeAgent.undoLastChange', async () => {
      const last = applied.pop();
      if (!last) return void vscode.window.showInformationMessage('Forge Agent: no agent change to undo.');
      const current = await ws.readFile(last.path).catch(() => undefined);
      if (current !== last.after) {
        const ok = await vscode.window.showWarningMessage(`${last.path} changed since the agent edit. Revert anyway?`, 'Revert', 'Cancel');
        if (ok !== 'Revert') return void applied.push(last);
      }
      if (last.before === undefined) await ws.deleteFile(last.path);
      else await ws.writeFile(last.path, last.before);
      panel.post({ type: 'status', level: 'info', text: `Reverted agent change to ${last.path}.` });
    }),
  );
}

/** Innermost function/class/method around the cursor, else ±10 lines. */
async function enclosingRange(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Range> {
  const symbols = (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', doc.uri)) ?? [];
  const kinds = new Set([vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Class]);
  let best: vscode.Range | undefined;
  const walk = (list: vscode.DocumentSymbol[]) => {
    for (const s of list) {
      if (!s.range.contains(pos)) continue;
      if (kinds.has(s.kind)) best = s.range;
      walk(s.children ?? []);
    }
  };
  walk(symbols);
  if (best) return new vscode.Range(best.start.line, 0, best.end.line, doc.lineAt(best.end.line).text.length);
  const start = Math.max(0, pos.line - 10);
  const end = Math.min(doc.lineCount - 1, pos.line + 10);
  return new vscode.Range(start, 0, end, doc.lineAt(end).text.length);
}

export function deactivate(): void {}
