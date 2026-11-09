import { isEventDelta, mergeEventDelta, TrueForge } from '@truefoundry/trueforge-sdk';
import { AGENT_INSTRUCTIONS } from './instructions';

export const MCP_SERVER_NAME = 'forge-editor';

export type UiEvent =
  | { type: 'delta'; id: string; threadId: string; text: string }
  | { type: 'message'; id: string; threadId: string; text: string; model?: string; toolCalls: { id: string; name: string; args: string }[] }
  | { type: 'tool'; threadId: string; toolCallId: string; result: string }
  | { type: 'thread'; threadId: string; status: 'created' | 'done'; title?: string }
  | { type: 'status'; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'model'; name: string }
  | { type: 'turn'; status: 'running' | 'done' | 'error' | 'cancelled'; message?: string };

export interface PendingApproval {
  threadId: string;
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
}

export interface RunnerHooks {
  onEvent(e: UiEvent): void;
  /** Resolve each paused tool call to allow/deny. Called once per approval pause. */
  decide(pending: PendingApproval[], signal: AbortSignal): Promise<{ toolCallId: string; threadId: string; allow: boolean; reason?: string }[]>;
}

export interface RunnerConfig {
  models: string[];
  instructions?: string;
  /** Workspace facts appended to the instructions (e.g. how to run tests). */
  workspaceNotes?: string;
  iterationLimit?: number;
}

type TurnInput = Parameters<TrueForge['sessions']['createTurnStream']>[1]['input'];

interface TurnResult {
  status: 'done' | 'error' | 'cancelled';
  message?: string;
  pending: PendingApproval[];
}

const MAX_RETRIES = 2;
const MAX_WAIT_MS = 30_000;
const CONTINUE_INPUT = [
  { type: 'user.message', content: 'The previous model call failed. Continue the task from where it stopped, using the tool results above.' },
] as TurnInput;

export class AgentRunner {
  private sessionId: string | undefined;
  private modelIndex = 0;
  private abort: AbortController | undefined;

  constructor(private readonly client: TrueForge, private readonly config: RunnerConfig, private readonly hooks: RunnerHooks) {}

  get running(): boolean {
    return this.abort !== undefined;
  }

  get model(): string {
    return this.config.models[this.modelIndex];
  }

  spec(model = this.model) {
    return {
      model: { name: model },
      instructions: [this.config.instructions ?? AGENT_INSTRUCTIONS, this.config.workspaceNotes].filter(Boolean).join('\n\nWorkspace notes:\n'),
      mcp_servers: [{ name: MCP_SERVER_NAME, preload: true, require_approval_for_tools: ['@write', '@destructive'] }],
      config: { iteration_limit: this.config.iterationLimit ?? 40 },
    };
  }

  reset(): void {
    this.sessionId = undefined;
    this.modelIndex = 0;
  }

  async send(text: string): Promise<void> {
    if (this.abort) throw new Error('A turn is already running');
    const abort = (this.abort = new AbortController());
    try {
      if (!this.sessionId) {
        const { data } = await this.client.sessions.create({ agent: { spec: this.spec() } } as never);
        this.sessionId = data.id;
      }
      let input: TurnInput = [{ type: 'user.message', content: text }] as TurnInput;
      for (;;) {
        const result = await this.runWithFallback(input, abort.signal);
        if (result.status !== 'done' || result.pending.length === 0) {
          this.hooks.onEvent({ type: 'turn', status: result.status, message: result.message });
          return;
        }
        const decisions = await this.hooks.decide(result.pending, abort.signal);
        if (abort.signal.aborted) return this.hooks.onEvent({ type: 'turn', status: 'cancelled' });
        input = decisions.map((d) => ({
          type: 'user.tool_approval',
          threadId: d.threadId,
          toolCallId: d.toolCallId,
          approval: d.allow ? { status: 'allow' } : { status: 'deny', reason: d.reason ?? 'Rejected by the user in diff review.' },
        })) as TurnInput;
      }
    } catch (e) {
      if (abort.signal.aborted) this.hooks.onEvent({ type: 'turn', status: 'cancelled' });
      else this.hooks.onEvent({ type: 'turn', status: 'error', message: (e as Error).message });
    } finally {
      this.abort = undefined;
    }
  }

  async cancel(): Promise<void> {
    if (!this.abort) return;
    this.abort.abort();
    if (this.sessionId) await this.client.sessions.cancel(this.sessionId).catch(() => undefined);
  }

  /**
   * Transient errors (429/5xx/network) wait and retry the same model, honouring the provider's retry hint.
   * When retries run out, or the error is permanent (bad key, unreachable), move to the next model and replay.
   */
  private async runWithFallback(input: TurnInput, signal: AbortSignal): Promise<TurnResult> {
    let attempts = 0;
    let switches = 0;
    for (;;) {
      const result = await this.runTurn(input, signal);
      if (result.status !== 'error' || signal.aborted) return result;
      // Approvals are consumed by the failed turn, so a replay continues from the session history instead.
      if (input?.some((i: { type: string }) => i.type !== 'user.message')) input = CONTINUE_INPUT;
      const reason = result.message ?? 'unknown error';
      if (isTransient(reason) && attempts < MAX_RETRIES) {
        attempts++;
        const wait = retryDelayMs(reason, attempts);
        this.hooks.onEvent({ type: 'status', level: 'warn', text: `${this.model}: ${shortReason(reason)} — retry ${attempts}/${MAX_RETRIES} in ${Math.round(wait / 1000)}s` });
        await sleep(wait, signal);
        continue;
      }
      if (this.config.models.length < 2 || switches >= this.config.models.length * 2) return result;
      const from = this.model;
      this.modelIndex = (this.modelIndex + 1) % this.config.models.length;
      switches++;
      attempts = 0;
      await this.client.sessions.update(this.sessionId!, { agent: { spec: this.spec() } } as never);
      this.hooks.onEvent({ type: 'status', level: 'warn', text: `${from} failed (${shortReason(reason)}) → switched to fallback ${this.model}; workspace unchanged` });
      this.hooks.onEvent({ type: 'model', name: this.model });
    }
  }

  private async runTurn(input: TurnInput, signal: AbortSignal): Promise<TurnResult> {
    const events = new Map<string, any>();
    const pending: PendingApproval[] = [];
    let done: any;
    this.hooks.onEvent({ type: 'turn', status: 'running' });
    try {
      const stream = await this.client.sessions.createTurnStream(this.sessionId!, { input }, { abortSignal: signal });
      for await (const { data: e } of stream.withMetadata() as AsyncIterable<{ data: any }>) {
        if (isEventDelta(e)) {
          const base = events.get(e.id);
          if (base) mergeEventDelta(base, e);
          if (e.content) this.hooks.onEvent({ type: 'delta', id: e.id, threadId: e.threadId, text: e.content });
          continue;
        }
        events.set(e.id, e);
        this.translate(e, events, pending);
        if (e.type === 'turn.done') done = e;
      }
    } catch (err) {
      if (signal.aborted) return { status: 'cancelled', pending: [] };
      return { status: 'error', message: (err as Error).message, pending: [] };
    }
    if (signal.aborted) return { status: 'cancelled', pending: [] };
    const state = done?.state ?? { status: 'error', message: 'stream ended without turn.done' };
    return { status: state.status, message: state.message, pending };
  }

  private translate(e: any, events: Map<string, any>, pending: PendingApproval[]): void {
    switch (e.type) {
      case 'model.message':
        if (e.content || e.toolCalls?.length) {
          this.hooks.onEvent({
            type: 'message',
            id: e.id,
            threadId: e.threadId,
            text: typeof e.content === 'string' ? e.content : '',
            model: e.model?.name,
            toolCalls: (e.toolCalls ?? []).map((t: any) => ({ id: t.id, name: t.function?.name, args: t.function?.arguments ?? '' })),
          });
        }
        break;
      case 'tool.response':
        this.hooks.onEvent({ type: 'tool', threadId: e.threadId, toolCallId: e.toolCallId, result: String(e.content) });
        break;
      case 'thread.created':
        this.hooks.onEvent({ type: 'thread', threadId: e.threadId, status: 'created', title: e.title });
        break;
      case 'thread.done':
        this.hooks.onEvent({ type: 'thread', threadId: e.threadId, status: 'done' });
        break;
      case 'thread.context_compaction.started':
        this.hooks.onEvent({ type: 'status', level: 'info', text: 'TrueForge is compacting the conversation context' });
        break;
      case 'tool.approval_required':
        for (const ref of e.toolCalls ?? []) {
          const call = events.get(ref.sourceEventId)?.toolCalls?.find((t: any) => t.id === ref.id);
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(call?.function?.arguments || '{}');
          } catch {
            /* malformed arguments are denied by the reviewer */
          }
          pending.push({ threadId: e.threadId, toolCallId: ref.id, name: call?.function?.name ?? 'unknown', args });
        }
        break;
    }
  }
}

export function isTransient(message: string): boolean {
  if (/\b(401|403)\b|invalid.*key|unauthori[sz]ed|permission/i.test(message)) return false;
  return /\b(408|429|5\d\d)\b|timeout|timed out|ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|Cannot connect|rate limit|overloaded/i.test(message);
}

/** Uses the provider's "retry in Ns" / retryDelay hint when present, else exponential backoff. */
export function retryDelayMs(message: string, attempt: number): number {
  const hint = /retry(?:Delay)?["\s:]*(?:in\s*)?"?(\d+(?:\.\d+)?)\s*s/i.exec(message);
  const ms = hint ? Math.ceil(Number(hint[1]) * 1000) + 500 : 2000 * 2 ** (attempt - 1);
  return Math.min(ms, MAX_WAIT_MS);
}

function shortReason(message: string): string {
  const code = /\b([45]\d\d)\b/.exec(message)?.[1];
  const clean = message.replace(/^\[Model Error\]\s*/, '');
  return code ? `${code}: ${clean.slice(0, 80)}` : clean.slice(0, 100);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });
}
