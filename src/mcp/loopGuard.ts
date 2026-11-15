const READ_ONLY = new Set(['read_file', 'list_dir', 'search', 'find_symbol', 'get_context']);
const EXPLORE_LIMIT = 8;
const EXPLORE_HARD_LIMIT = 14;

/**
 * Weak models loop: they repeat identical searches or keep exploring instead of editing.
 * The guard appends a steering note to the tool result, and past a hard limit refuses further
 * read-only calls until the model proposes an edit.
 */
export class LoopGuard {
  private seen = new Map<string, number>();
  private explored = 0;

  reset(): void {
    this.seen.clear();
    this.explored = 0;
  }

  /** Returns a refusal message once exploration exceeds the hard limit. */
  blocked(name: string): string | undefined {
    if (!READ_ONLY.has(name) || this.explored < EXPLORE_HARD_LIMIT) return undefined;
    return `[loop guard] Exploration limit reached (${this.explored} read-only calls without an edit). Read-only tools are paused: call propose_edit now with what you already know.`;
  }

  note(name: string, args: unknown): string | undefined {
    if (!READ_ONLY.has(name)) {
      if (name === 'propose_edit') this.explored = 0;
      return undefined;
    }
    const key = `${name}:${JSON.stringify(args)}`;
    const count = (this.seen.get(key) ?? 0) + 1;
    this.seen.set(key, count);
    this.explored++;
    if (count > 1)
      return `[loop guard] You already called ${name} with these exact arguments (${count} times); the result is the same as before. Do not repeat it. Use what you have and move on to propose_edit.`;
    if (this.explored >= EXPLORE_LIMIT && this.explored % 4 === 0)
      return `[loop guard] ${this.explored} read-only calls since the last edit. You have enough context: propose the edits now (one propose_edit per file, several files in the same step).`;
    return undefined;
  }
}
