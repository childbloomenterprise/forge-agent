import * as vscode from 'vscode';
import { SymbolHit, Workspace } from './workspace';

const SYMBOL_KINDS: Record<number, string> = {
  [vscode.SymbolKind.Class]: 'class',
  [vscode.SymbolKind.Function]: 'function',
  [vscode.SymbolKind.Method]: 'method',
  [vscode.SymbolKind.Variable]: 'variable',
  [vscode.SymbolKind.Constant]: 'constant',
  [vscode.SymbolKind.Module]: 'module',
};

/** Reads see unsaved editor buffers; writes go through WorkspaceEdit so Ctrl+Z undoes them. */
export class VsCodeWorkspace extends Workspace {
  uri(rel: string): vscode.Uri {
    return vscode.Uri.file(this.resolve(rel));
  }

  private openDoc(rel: string): vscode.TextDocument | undefined {
    const fsPath = this.resolve(rel);
    return vscode.workspace.textDocuments.find((d) => d.uri.fsPath === fsPath);
  }

  override async readFile(rel: string): Promise<string> {
    return this.openDoc(rel)?.getText() ?? super.readFile(rel);
  }

  override async writeFile(rel: string, text: string): Promise<void> {
    const uri = this.uri(rel);
    const edit = new vscode.WorkspaceEdit();
    if (!(await this.exists(rel))) {
      edit.createFile(uri, { ignoreIfExists: true, contents: new TextEncoder().encode(text) });
      if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`could not create ${rel}`);
      return;
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`could not edit ${rel}`);
    await doc.save();
  }

  async deleteFile(rel: string): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    edit.deleteFile(this.uri(rel), { ignoreIfNotExists: true });
    await vscode.workspace.applyEdit(edit);
  }

  override async findSymbol(name: string): Promise<SymbolHit[]> {
    const symbols = (await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', name)) ?? [];
    const exact = symbols.filter((s) => s.name === name && s.location.uri.fsPath.startsWith(this.root));
    if (exact.length === 0) return super.findSymbol(name);
    return exact.slice(0, 20).map((s) => ({
      name: s.name,
      kind: SYMBOL_KINDS[s.kind] ?? 'symbol',
      path: this.relative(s.location.uri.fsPath),
      line: s.location.range.start.line + 1,
      container: s.containerName || undefined,
    }));
  }
}
