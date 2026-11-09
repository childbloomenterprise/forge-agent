import { createHash } from 'node:crypto';
import { diffArrays } from 'diff';

export interface TextReplacement {
  old_text: string;
  new_text: string;
}

export interface Hunk {
  index: number;
  /** 0-based line in the original where the hunk starts. */
  originalStart: number;
  removed: string[];
  added: string[];
}

export function splitLines(text: string): string[] {
  return text.length === 0 ? [] : text.split(/(?<=\n)/);
}

/** Applies search/replace edits in order. Each old_text must match exactly once. */
export function applyReplacements(original: string, edits: TextReplacement[]): string {
  let text = original;
  edits.forEach((edit, i) => {
    if (edit.old_text === '') {
      if (text.length > 0) throw new Error(`edit ${i + 1}: empty old_text is only allowed when creating a new file`);
      text = edit.new_text;
      return;
    }
    const at = text.indexOf(edit.old_text);
    if (at < 0) throw new Error(`edit ${i + 1}: old_text not found in file; re-read the file and copy the text exactly`);
    if (text.indexOf(edit.old_text, at + 1) >= 0) {
      throw new Error(`edit ${i + 1}: old_text matches more than once; include more surrounding lines`);
    }
    text = text.slice(0, at) + edit.new_text + text.slice(at + edit.old_text.length);
  });
  return text;
}

/** Line-level hunks with no context, so each hunk can be accepted or rejected independently. */
export function computeHunks(original: string, proposed: string): Hunk[] {
  const hunks: Hunk[] = [];
  let line = 0;
  let current: Hunk | undefined;
  for (const part of diffArrays(splitLines(original), splitLines(proposed))) {
    if (!part.added && !part.removed) {
      current = undefined;
      line += part.value.length;
      continue;
    }
    if (!current) {
      current = { index: hunks.length, originalStart: line, removed: [], added: [] };
      hunks.push(current);
    }
    if (part.removed) {
      current.removed.push(...part.value);
      line += part.value.length;
    } else {
      current.added.push(...part.value);
    }
  }
  return hunks;
}

/** Rebuilds the file from the original, applying only the accepted hunks. */
export function applyHunks(original: string, hunks: Hunk[], accepted: ReadonlySet<number>): string {
  const lines = splitLines(original);
  const out: string[] = [];
  let line = 0;
  for (const hunk of hunks) {
    out.push(...lines.slice(line, hunk.originalStart));
    if (accepted.has(hunk.index)) out.push(...hunk.added);
    else out.push(...hunk.removed);
    line = hunk.originalStart + hunk.removed.length;
  }
  out.push(...lines.slice(line));
  return out.join('');
}

export function editKey(path: string, edits: TextReplacement[]): string {
  return createHash('sha256').update(JSON.stringify([path, edits.map((e) => [e.old_text, e.new_text])])).digest('hex');
}
