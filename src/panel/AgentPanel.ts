import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

export type PanelInbound =
  | { type: 'send'; text: string }
  | { type: 'cancel' }
  | { type: 'newSession' }
  | { type: 'decision'; id: string; accepted?: number[]; allow?: boolean }
  | { type: 'ready' };

/** Sidebar webview. Messages posted before the view resolves are queued and replayed. */
export class AgentPanel implements vscode.WebviewViewProvider {
  static readonly viewId = 'forgeAgent.panel';
  private view: vscode.WebviewView | undefined;
  private queue: unknown[] = [];
  private readonly emitter = new vscode.EventEmitter<PanelInbound>();
  readonly onMessage = this.emitter.event;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = randomBytes(16).toString('base64');
    const script = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js'));
    const style = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css'));
    view.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${style}"></head><body>
<div id="banner" hidden></div>
<div id="log"></div>
<form id="composer"><textarea id="input" rows="3" placeholder="Ask Forge to change the code…  (Enter to send, Shift+Enter for newline)"></textarea>
<div class="row"><span id="model"></span><button type="button" id="new" title="New session">New</button><button type="button" id="cancel" disabled>Cancel</button><button type="submit" id="send">Send</button></div></form>
<script nonce="${nonce}" src="${script}"></script></body></html>`;
    view.webview.onDidReceiveMessage((m: PanelInbound) => {
      if (m.type === 'ready') this.flush();
      this.emitter.fire(m);
    });
    view.onDidDispose(() => (this.view = undefined));
  }

  post(message: unknown): void {
    this.queue.push(message);
    if (this.view) this.flush();
  }

  private flush(): void {
    if (!this.view) return;
    for (const m of this.queue.splice(0)) void this.view.webview.postMessage(m);
  }
}
