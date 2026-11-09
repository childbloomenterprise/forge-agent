import { applyHunks, applyReplacements, computeHunks, editKey, Hunk, TextReplacement } from './staging';

export interface ReviewRequest {
  key: string;
  path: string;
  isNew: boolean;
  original: string;
  proposed: string;
  hunks: Hunk[];
  summary?: string;
}

/**
 * Holds per-hunk decisions between the TrueForge approval pause and the tool execution.
 * Decisions are keyed by a hash of the tool arguments, which TrueForge replays unchanged.
 */
export class ReviewBroker {
  private decisions = new Map<string, Set<number>>();

  prepare(path: string, edits: TextReplacement[], original: string, isNew: boolean, summary?: string): ReviewRequest {
    const proposed = applyReplacements(original, edits);
    return { key: editKey(path, edits), path, isNew, original, proposed, hunks: computeHunks(original, proposed), summary };
  }

  record(key: string, accepted: Iterable<number>): void {
    this.decisions.set(key, new Set(accepted));
  }

  take(key: string): Set<number> | undefined {
    const d = this.decisions.get(key);
    this.decisions.delete(key);
    return d;
  }

  clear(): void {
    this.decisions.clear();
  }

  static result(req: ReviewRequest, accepted: ReadonlySet<number>): string {
    return applyHunks(req.original, req.hunks, accepted);
  }
}
