import { SearchHit, Workspace } from '../workspace';

export type ContextMode = 'full' | 'snippets' | 'omitted';

export interface ContextItem {
  path: string;
  reason: string;
  score: number;
  tokens: number;
  mode: ContextMode;
}

export interface ContextPack {
  items: ContextItem[];
  keywords: string[];
  budget: number;
  used: number;
  /** Markdown block appended to the user's message. */
  text: string;
}

interface Candidate {
  path: string;
  score: number;
  reasons: string[];
  hitLines: number[];
  focusLines?: number[];
  forced?: boolean;
}

const TEXT_GLOBS = ['*.py', '*.pyi', '*.rst', '*.md', '*.ts', '*.tsx', '*.js', '*.jsx', '*.toml', '*.cfg', '*.ini', '*.json', '*.yaml', '*.yml', '*.html', '*.txt'];
const STOPWORDS = new Set(
  'the a an and or to of in for on with that this these those is are be been it its as by at from into so all any use using which also than then them they their there when where what while should must can could would will shall not no yes only each every both either least most more less such like via per make makes made add adds added new whose contain contains built show shows document documented file files code way ensure sure keep same other some one two three task tasks change changes changed modify update updates'.split(' '),
);
const COMMON_DF_RATIO = 0.35;
const SECONDARY_PRIOR = 0.4;
const FULL_FILE_MAX_TOKENS = 3000;
/** The top-ranked file may be shown whole if it fits in this share of the budget, so the agent can edit it without re-reading. */
const PRIMARY_FILE_SHARE = 0.65;
/** Files scoring below this fraction of the best score are listed but not packed. */
const MIN_RELATIVE_SCORE = 0.15;
const SNIPPET_RADIUS = 12;
const MAX_SNIPPETS = 4;
const MAX_FILES = 8;

export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/** Crude suffix stripping so "masking" matches "mask" and "keys" matches "key" (search is substring-based). */
export function stemWord(w: string): string {
  if (w.includes('_')) return w;
  if (w.endsWith('ing') && !w.endsWith('string') && w.length >= 6) return w.slice(0, -3);
  if (w.endsWith('ies') && w.length >= 5) return w.slice(0, -3) + 'y';
  if (w.endsWith('s') && !w.endsWith('ss') && w.length >= 4) return w.slice(0, -1);
  return w;
}

export function extractKeywords(task: string): string[] {
  const words = new Set<string>();
  for (const raw of task.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
    const w = stemWord(raw.toLowerCase());
    if (w.length >= 3 && !STOPWORDS.has(w)) words.add(w);
    if (raw.includes('_')) for (const part of w.split('_')) if (part.length >= 3 && !STOPWORDS.has(part)) words.add(part);
  }
  return [...words].slice(0, 24);
}

export function parseMentions(task: string): string[] {
  return [...task.matchAll(/(?:^|\s)@([\w./:-]+[\w])/g)].map((m) => m[1]);
}

const stem = (p: string) => p.split('/').pop()!.replace(/\.[^.]+$/, '').toLowerCase();

/**
 * Ranks workspace files for a task: TF-IDF over ripgrep hits, boosted for path and definition matches,
 * plus explicit @file/@symbol mentions and test/doc companions of the top source files. Packs the result
 * into a token budget and explains every choice.
 */
export class ContextEngine {
  constructor(private readonly ws: Workspace) {}

  async build(task: string, budget: number): Promise<ContextPack> {
    const keywords = extractKeywords(task.replace(/(?:^|\s)@[\w./:-]+/g, ' '));
    const files = await this.ws.listFiles(TEXT_GLOBS);
    const candidates = new Map<string, Candidate>();
    const get = (path: string) => {
      let c = candidates.get(path);
      if (!c) candidates.set(path, (c = { path, score: 0, reasons: [], hitLines: [] }));
      return c;
    };

    await this.addMentions(task, get);
    await this.addKeywordScores(keywords, files.length, get);

    const ranked = [...candidates.values()].filter((c) => c.forced || c.score > 0).sort((a, b) => Number(!!b.forced) - Number(!!a.forced) || b.score - a.score);
    const selected = ranked.slice(0, MAX_FILES);
    this.addCompanions(selected, new Set(files), get);
    selected.sort((a, b) => Number(!!b.forced) - Number(!!a.forced) || b.score - a.score);
    return this.pack(selected.slice(0, MAX_FILES + 3), keywords, budget);
  }

  private async addMentions(task: string, get: (p: string) => Candidate): Promise<void> {
    for (const mention of parseMentions(task)) {
      const name = mention.replace(/^symbol:/, '');
      if (!mention.startsWith('symbol:') && (await this.ws.exists(name).catch(() => false))) {
        const c = get(name);
        c.forced = true;
        c.reasons.push(`@${name} mentioned by you`);
        continue;
      }
      const symbol = name.split(/[.:]/).pop()!;
      const defs = await this.ws.findSymbol(symbol);
      for (const d of defs.slice(0, 2)) {
        const c = get(d.path);
        c.forced = true;
        c.reasons.push(`@${symbol} is defined here (line ${d.line})`);
        c.focusLines = [...(c.focusLines ?? []), d.line];
      }
    }
  }

  private async addKeywordScores(keywords: string[], totalFiles: number, get: (p: string) => Candidate): Promise<void> {
    if (keywords.length === 0) return;
    const res = new Map(keywords.map((k) => [k, new RegExp(`\\b${escapeRe(k)}`, 'i')]));
    const hits = await this.ws.grep(keywords.map((k) => `\\b${escapeRe(k)}`), TEXT_GLOBS);
    const tf = new Map<string, Map<string, number>>();
    const linesByFile = new Map<string, SearchHit[]>();
    for (const h of hits) {
      for (const k of keywords) {
        if (!res.get(k)!.test(h.text)) continue;
        let m = tf.get(k);
        if (!m) tf.set(k, (m = new Map()));
        m.set(h.path, (m.get(h.path) ?? 0) + 1);
      }
      let l = linesByFile.get(h.path);
      if (!l) linesByFile.set(h.path, (l = []));
      l.push(h);
    }
    const idf = new Map(keywords.map((k) => [k, Math.log(1 + totalFiles / (tf.get(k)?.size || totalFiles))]));
    const defRe = /^\s*(?:async\s+)?(?:def|class|function)\s+([A-Za-z_]\w*)|^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_]\w*)\s*=/;
    const contributions = new Map<string, { k: string; s: number; why: string }[]>();
    const seen = new Set<string>();
    const common = new Set(keywords.filter((k) => (tf.get(k)?.size ?? 0) > totalFiles * COMMON_DF_RATIO));
    const note = (path: string, k: string, s: number, why: string, kind: string) => {
      if (common.has(k) || seen.has(`${path}\0${k}\0${kind}`)) return;
      seen.add(`${path}\0${k}\0${kind}`);
      let list = contributions.get(path);
      if (!list) contributions.set(path, (list = []));
      list.push({ k, s, why });
    };

    for (const [k, perFile] of tf) {
      for (const [path, count] of perFile) note(path, k, idf.get(k)! * (1 + Math.log(count)), `"${k}" ×${count}`, 'tf');
    }
    for (const [path, lines] of linesByFile) {
      const s = stem(path);
      for (const k of keywords) if (s === k || s === `test_${k}` || s.split(/[_-]/).includes(k)) note(path, k, 3 * idf.get(k)!, `file name matches "${k}"`, 'path');
      for (const h of lines) {
        const m = defRe.exec(h.text);
        const name = (m?.[1] ?? m?.[2])?.toLowerCase();
        if (!name) continue;
        for (const k of keywords) if (name === k || name.split('_').includes(k)) note(path, k, 4 * idf.get(k)!, `defines ${m![1] ?? m![2]}`, 'def');
      }
    }

    for (const [path, list] of contributions) {
      const c = get(path);
      c.score += list.reduce((a, x) => a + x.s, 0);
      const distinct = new Set(list.map((x) => x.k)).size;
      c.score *= 1 + 0.25 * (distinct - 1);
      if (/(^|\/)(tests?|docs|examples)\//.test(path)) c.score *= SECONDARY_PRIOR;
      if (/(^|\/)(CHANGES|CHANGELOG|HISTORY|NEWS)[^/]*$/i.test(path)) c.score *= SECONDARY_PRIOR * SECONDARY_PRIOR;
      const top = list.sort((a, b) => b.s - a.s).filter((x, i, arr) => arr.findIndex((y) => y.why === x.why) === i).slice(0, 3);
      c.reasons.push(top.map((x) => x.why).join(', '));
      // Snippet anchors: lines matching the most distinct (non-common) keywords, definitions first.
      const kws = keywords.filter((k) => !common.has(k));
      c.hitLines = (linesByFile.get(path) ?? [])
        .map((h) => ({ line: h.line, n: kws.filter((k) => res.get(k)!.test(h.text)).length + (defRe.test(h.text) ? 1.5 : 0) }))
        .filter((x) => x.n > 0)
        .sort((a, b) => b.n - a.n)
        .slice(0, MAX_SNIPPETS * 2)
        .map((x) => x.line);
    }
  }

  /** Changing a module usually means changing its tests and docs too. */
  private addCompanions(selected: Candidate[], files: Set<string>, get: (p: string) => Candidate): void {
    const sources = selected.filter((c) => !/(^|\/)(tests?|docs)\//.test(c.path) && /\.(py|ts|js)$/.test(c.path)).slice(0, 3);
    for (const src of sources) {
      const s = stem(src.path);
      const companions = [
        [`tests/test_${s}.py`, `tests for ${src.path}`],
        [`docs/${s}.rst`, `docs for ${src.path}`],
        [`docs/${s}.md`, `docs for ${src.path}`],
      ];
      for (const [path, why] of companions) {
        if (!files.has(path)) continue;
        const c = get(path);
        if (!c.reasons.includes(why)) c.reasons.unshift(why);
        c.score = Math.max(c.score, src.score * 0.9);
        if (!selected.includes(c)) selected.push(c);
      }
    }
  }

  private async pack(selected: Candidate[], keywords: string[], budget: number): Promise<ContextPack> {
    const items: ContextItem[] = [];
    const blocks: string[] = [];
    let used = 0;
    const top = selected[0]?.score ?? 0;
    for (const [rank, c] of selected.entries()) {
      const reason = c.reasons.filter(Boolean).join('; ');
      const text = await this.ws.readFile(c.path).catch(() => '');
      const full = estimateTokens(text);
      let block: string | undefined;
      let mode: ContextMode = 'omitted';
      const fullLimit = rank === 0 && !c.path.match(/(^|\/)(tests?|docs)\//) ? budget * PRIMARY_FILE_SHARE : FULL_FILE_MAX_TOKENS;
      if (!c.forced && c.score < top * MIN_RELATIVE_SCORE) {
        // weak match: report it, but leave the budget for better files
      } else if (full <= fullLimit && used + full <= budget) {
        block = `### ${c.path} (full file)\n\`\`\`\n${text}\n\`\`\``;
        mode = 'full';
      } else {
        const snippet = renderSnippets(c.path, text, [...(c.focusLines ?? []), ...c.hitLines]);
        if (snippet && used + estimateTokens(snippet) <= budget) {
          block = snippet;
          mode = 'snippets';
        }
      }
      const tokens = block ? estimateTokens(block) : 0;
      used += tokens;
      if (block) blocks.push(block);
      items.push({ path: c.path, reason: reason || 'related', score: Math.round(c.score * 10) / 10, tokens, mode });
    }
    const table = items.map((i) => `- ${i.path} [${i.mode}, ${i.tokens} tok]: ${i.reason}`).join('\n');
    const text =
      `---\nAutomatically retrieved context (budget ${budget} tokens, used ${used}). Files chosen and why:\n${table}\n` +
      `Use read_file for anything not shown in full; use search/find_symbol to look further.\n\n${blocks.join('\n\n')}`;
    return { items, keywords, budget, used, text };
  }
}

/** Outline (definitions) plus windows around the matching lines. */
function renderSnippets(path: string, text: string, lines: number[]): string | undefined {
  const all = text.split('\n');
  const outline = all
    .map((l, i) => [l, i + 1] as const)
    .filter(([l]) => /^(?:class|def|async def|function|export)\s/.test(l))
    .map(([l, n]) => `${n}: ${l.trim()}`)
    .slice(0, 60);
  const windows: [number, number][] = [];
  for (const line of new Set(lines)) {
    if (windows.length >= MAX_SNIPPETS) break;
    if (windows.some(([s, e]) => line >= s && line <= e)) continue;
    windows.push([Math.max(1, line - SNIPPET_RADIUS), Math.min(all.length, line + SNIPPET_RADIUS)]);
  }
  windows.sort((a, b) => a[0] - b[0]);
  const chosen = windows.slice(0, MAX_SNIPPETS);
  if (chosen.length === 0 && outline.length === 0) return undefined;
  const parts = chosen.map(([s, e]) => `lines ${s}-${e}:\n\`\`\`\n${all.slice(s - 1, e).join('\n')}\n\`\`\``);
  return `### ${path} (outline + ${chosen.length} snippet(s) of ${all.length} lines)\nOutline:\n${outline.join('\n')}\n${parts.join('\n')}`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
