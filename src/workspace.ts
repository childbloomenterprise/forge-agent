import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export interface SymbolHit {
  name: string;
  kind: string;
  path: string;
  line: number;
  container?: string;
}

export const IGNORED_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.tox', 'dist', 'build', '.mypy_cache', '.pytest_cache']);

/** Editor-agnostic workspace access. The VS Code implementation overrides reads/writes to use open documents. */
export class Workspace {
  constructor(readonly root: string) {}

  resolve(rel: string): string {
    const abs = path.resolve(this.root, rel);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) throw new Error(`path escapes workspace: ${rel}`);
    return abs;
  }

  relative(abs: string): string {
    return path.relative(this.root, abs).split(path.sep).join('/');
  }

  async exists(rel: string): Promise<boolean> {
    return fs.access(this.resolve(rel)).then(() => true, () => false);
  }

  async readFile(rel: string): Promise<string> {
    return fs.readFile(this.resolve(rel), 'utf8');
  }

  async writeFile(rel: string, text: string): Promise<void> {
    const abs = this.resolve(rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, text);
  }

  async listDir(rel: string): Promise<string[]> {
    const entries = await fs.readdir(this.resolve(rel), { withFileTypes: true });
    return entries
      .filter((e) => !IGNORED_DIRS.has(e.name))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
  }

  async listFiles(globs: string[] = []): Promise<string[]> {
    const args = ['--files', ...globs.flatMap((g) => ['-g', g])];
    const out = await run('rg', args, this.root).catch((e: RunError) => (e.code === 1 ? '' : Promise.reject(e)));
    return out.split('\n').filter(Boolean).map((p) => p.split(path.sep).join('/')).sort();
  }

  async search(query: string, opts: { regex?: boolean; glob?: string; maxResults?: number } = {}): Promise<SearchHit[]> {
    const max = opts.maxResults ?? 50;
    const args = ['-n', '--no-heading', '--color', 'never', '-m', '20', '--max-columns', '300'];
    if (!opts.regex) args.push('-F');
    if (opts.glob) args.push('-g', opts.glob);
    args.push('-e', query, '.');
    const out = await run('rg', args, this.root).catch((e: RunError) => (e.code === 1 ? '' : Promise.reject(e)));
    const hits: SearchHit[] = [];
    for (const row of out.split('\n')) {
      const m = /^(?:\.\/)?(.+?):(\d+):(.*)$/.exec(row);
      if (!m) continue;
      hits.push({ path: m[1].split(path.sep).join('/'), line: Number(m[2]), text: m[3].trim() });
      if (hits.length >= max) break;
    }
    return hits;
  }

  /** Raw ripgrep line matches for several regex patterns at once (case-insensitive). */
  async grep(patterns: string[], globs: string[] = []): Promise<SearchHit[]> {
    if (patterns.length === 0) return [];
    const args = ['-n', '-i', '--no-heading', '--color', 'never', '--max-columns', '400', '-m', '400'];
    for (const d of IGNORED_DIRS) args.push('-g', `!${d}/`);
    for (const g of globs) args.push('-g', g);
    for (const p of patterns) args.push('-e', p);
    args.push('.');
    const out = await run('rg', args, this.root).catch((e: RunError) => (e.code === 1 ? '' : Promise.reject(e)));
    const hits: SearchHit[] = [];
    for (const row of out.split('\n')) {
      const m = /^(?:\.\/)?(.+?):(\d+):(.*)$/.exec(row);
      if (m) hits.push({ path: m[1].split(path.sep).join('/'), line: Number(m[2]), text: m[3] });
    }
    return hits;
  }

  /** Regex fallback for definitions (Python/JS/TS); VS Code uses the language server instead. */
  async findSymbol(name: string): Promise<SymbolHit[]> {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = `^\\s*(?:async\\s+)?(?:def|class|function|const|let|var|export\\s+(?:default\\s+)?(?:function|class|const))\\s+${escaped}\\b`;
    const hits = await this.search(pattern, { regex: true, maxResults: 20 });
    return hits.map((h) => ({
      name,
      kind: /\bclass\b/.test(h.text) ? 'class' : /\b(def|function)\b/.test(h.text) ? 'function' : 'variable',
      path: h.path,
      line: h.line,
    }));
  }

  async runCommand(command: string, timeoutMs = 120_000): Promise<{ code: number; output: string }> {
    return new Promise((resolve) => {
      execFile('bash', ['-lc', command], { cwd: this.root, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as RunError).code === 'number' ? Number((err as RunError).code) : 1) : 0;
        resolve({ code, output: `${stdout}${stderr}` });
      });
    });
  }
}

interface RunError extends Error {
  code?: number | string;
}

function run(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/** Facts the agent would otherwise waste tool calls discovering. */
export async function describeWorkspace(ws: Workspace): Promise<string> {
  const notes: string[] = [`Workspace root: ${ws.root}. All tool paths are relative to it.`];
  for (const venv of ['.venv', 'venv']) {
    if (await ws.exists(`${venv}/bin/python`)) {
      notes.push(`Python: use ${venv}/bin/python (e.g. \`${venv}/bin/python -m pytest tests/test_x.py -q\`).`);
      break;
    }
  }
  if (await ws.exists('package.json')) notes.push('Node project: see package.json scripts for tests.');
  return notes.join('\n');
}
