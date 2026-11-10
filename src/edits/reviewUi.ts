import * as vscode from 'vscode';
import { Hunk } from './staging';
import { ReviewRequest } from './reviews';

export const PROPOSED_SCHEME = 'forge-proposed';

type HunkState = 'pending' | 'accept' | 'reject';

interface OpenReview {
  req: ReviewRequest;
  states: HunkState[];
  newStarts: number[];
  resolve: (accepted: number[]) => void;
}

/** Line in the proposed text where each hunk begins. */
export function proposedStarts(hunks: Hunk[]): number[] {
  let shift = 0;
  return hunks.map((h) => {
    const start = h.originalStart + shift;
    shift += h.added.length - h.removed.length;
    return start;
  });
}

/**
 * Renders a proposal as a VS Code diff editor (current file ↔ proposal) with per-hunk Accept/Reject CodeLenses.
 * The review resolves when every hunk is decided, or via Accept all / Reject all, or from the panel.
 */
export class ReviewUi implements vscode.CodeLensProvider, vscode.TextDocumentContentProvider {
  private readonly open = new Map<string, OpenReview>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;

  register(): vscode.Disposable {
    return vscode.Disposable.from(
      vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, this),
      vscode.languages.registerCodeLensProvider({ scheme: PROPOSED_SCHEME }, this),
      vscode.commands.registerCommand('forgeAgent.hunk', (id: string, index: number, accept: boolean) => this.setHunk(id, index, accept)),
      vscode.commands.registerCommand('forgeAgent.hunkAll', (id: string, accept: boolean) => this.finish(id, accept ? 'accept' : 'reject')),
      vscode.commands.registerCommand('forgeAgent.hunkApplySelection', (id: string) => this.finish(id)),
    );
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    if (uri.query === 'empty') return '';
    return this.open.get(uri.query)?.req.proposed ?? '';
  }

  async show(id: string, req: ReviewRequest, workspaceUri: (rel: string) => vscode.Uri, signal: AbortSignal): Promise<number[]> {
    const accepted = new Promise<number[]>((resolve) => {
      this.open.set(id, { req, states: req.hunks.map(() => 'pending'), newStarts: proposedStarts(req.hunks), resolve });
      signal.addEventListener('abort', () => this.finish(id, 'reject'), { once: true });
    });
    const right = vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: `/${req.path}`, query: id });
    const left = req.isNew ? vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: `/${req.path}`, query: 'empty' }) : workspaceUri(req.path);
    await vscode.commands.executeCommand('vscode.diff', left, right, `Forge proposal: ${req.path} (${req.hunks.length} hunk(s))`, { preview: false });
    return accepted;
  }

  /** Resolve from outside (panel buttons). */
  resolveExternally(id: string, accepted: number[]): void {
    const r = this.open.get(id);
    if (!r) return;
    r.states = r.req.hunks.map((h) => (accepted.includes(h.index) ? 'accept' : 'reject'));
    this.finish(id);
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const r = this.open.get(doc.uri.query);
    if (!r) return [];
    const top = new vscode.Range(0, 0, 0, 0);
    const lenses = [
      new vscode.CodeLens(top, { title: '$(check-all) Accept all', command: 'forgeAgent.hunkAll', arguments: [doc.uri.query, true] }),
      new vscode.CodeLens(top, { title: '$(close-all) Reject all', command: 'forgeAgent.hunkAll', arguments: [doc.uri.query, false] }),
      new vscode.CodeLens(top, { title: 'Apply decided hunks', command: 'forgeAgent.hunkApplySelection', arguments: [doc.uri.query] }),
    ];
    r.req.hunks.forEach((h, i) => {
      const line = Math.min(r.newStarts[i], Math.max(0, doc.lineCount - 1));
      const range = new vscode.Range(line, 0, line, 0);
      const state = r.states[i];
      const label = state === 'pending' ? `Hunk ${i + 1}` : state === 'accept' ? `Hunk ${i + 1}: accepted` : `Hunk ${i + 1}: rejected`;
      lenses.push(
        new vscode.CodeLens(range, { title: label, command: '' }),
        new vscode.CodeLens(range, { title: '$(check) Accept', command: 'forgeAgent.hunk', arguments: [doc.uri.query, h.index, true] }),
        new vscode.CodeLens(range, { title: '$(x) Reject', command: 'forgeAgent.hunk', arguments: [doc.uri.query, h.index, false] }),
      );
    });
    return lenses;
  }

  private setHunk(id: string, index: number, accept: boolean): void {
    const r = this.open.get(id);
    if (!r) return;
    r.states[index] = accept ? 'accept' : 'reject';
    if (r.states.every((s) => s !== 'pending')) this.finish(id);
    else this.changed.fire();
  }

  /** `fill` overrides every hunk (Accept all / Reject all); without it, undecided hunks are rejected. */
  private finish(id: string, fill?: 'accept' | 'reject'): void {
    const r = this.open.get(id);
    if (!r) return;
    this.open.delete(id);
    const states = r.states.map((s) => fill ?? (s === 'accept' ? 'accept' : 'reject'));
    r.resolve(r.req.hunks.filter((_, i) => states[i] === 'accept').map((h) => h.index));
    this.changed.fire();
    void closeTabs(id);
  }
}

async function closeTabs(id: string): Promise<void> {
  const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => {
    const input = t.input as { modified?: vscode.Uri } | undefined;
    return input?.modified?.scheme === PROPOSED_SCHEME && input.modified.query === id;
  });
  if (tabs.length) await vscode.window.tabGroups.close(tabs);
}
