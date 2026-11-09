import * as vscode from 'vscode';
import { TrueForge } from '@truefoundry/trueforge-sdk';
import { ReviewBroker, ReviewRequest } from './edits/reviews';
import { startMcpServer, RunningMcpServer } from './mcp/server';
import { prepareEdit, ToolDeps } from './mcp/tools';
import { AgentPanel, PanelInbound } from './panel/AgentPanel';
import { registerMcpServer } from './trueforge/register';
import { AgentRunner, PendingApproval, UiEvent } from './trueforge/runner';
import { VsCodeWorkspace } from './vscodeWorkspace';
import { describeWorkspace } from './workspace';

const PROPOSED_SCHEME = 'forge-proposed';
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
  const proposed = new Map<string, string>();
  ctx.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, { provideTextDocumentContent: (uri) => proposed.get(uri.query) ?? '' }),
  );

  const deps: ToolDeps = {
    ws,
    reviews,
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

  const showProposedDiff = async (req: ReviewRequest) => {
    const key = `${req.key.slice(0, 12)}`;
    proposed.set(key, req.proposed);
    const right = vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: `/${req.path}`, query: key });
    const left = req.isNew ? vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: `/${req.path}`, query: 'empty' }) : ws.uri(req.path);
    await vscode.commands.executeCommand('vscode.diff', left, right, `Forge proposal: ${req.path}`, { preview: true, preserveFocus: true });
  };

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
          void showProposedDiff(req);
          const accepted = await ask(
            {
              type: 'review',
              path: req.path,
              isNew: req.isNew,
              summary: req.summary,
              hunks: req.hunks.map((h) => ({ index: h.index, start: h.originalStart, removed: h.removed, added: h.added })),
            },
            signal,
            (m) => m.accepted ?? [],
            [] as number[],
          );
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
  showModel(runner.model);

  const send = async (text: string) => {
    panel.post({ type: 'user', text });
    try {
      await ensureRegistered();
    } catch (e) {
      panel.post({ type: 'status', level: 'error', text: `TrueForge is not reachable at ${cfg.get('trueforgeUrl')} (${(e as Error).message}). Start it with: ${START_HINT}` });
      return;
    }
    await runner.send(text);
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
    await runner.cancel();
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

export function deactivate(): void {}
