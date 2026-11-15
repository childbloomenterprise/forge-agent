# Forge Agent: a VS Code coding agent on TrueForge

**Team:** TM-F8AE7773192 (competition ID TFF-51725D9BE94F) · **Repo:** https://github.com/childbloomenterprise/forge-agent · **Video:** _<link>_

## 1. What it is

Forge Agent is a VS Code extension whose agent loop runs entirely on TrueForge. The extension is a thin client:
it creates TrueForge sessions with the SDK, streams their events into a sidebar panel, and hosts a local MCP
server that gives the agent editor tools. TrueForge owns model calls, tool selection, approvals and session history.

```
VS Code extension                                TrueForge (localhost:8790)
 panel: stream, cancel, context report  ◀─ SDK turn stream ─  agent loop, @write approvals
 diff review (panel + diff editor)      ─ tool approvals ──▶  deferred tools, history
 fallback controller (retry → switch)   ─ sessions.update ─▶  model per session
 MCP server 127.0.0.1 (bearer token)    ◀──── MCP/HTTP ─────  calls editor tools
```

**Editor tools (MCP):** `read_file`, `list_dir`, `search` (ripgrep), `find_symbol` (VS Code symbol providers),
`get_context`, `propose_edit` (write, approval-gated), `run_command` (destructive, approval-gated).
They are registered with `preload: true` so even weak models see them without a discovery round-trip.

## 2. Rubric scorecard

| Rubric item | What we do | Video |
|---|---|---|
| Context retrieval (15) | Ranks files by IDF-weighted keyword hits, filename and symbol-definition matches; pulls in test/doc companions; `@file` / `@symbol:name`; packs into a 16k-token budget (primary file whole, others as outline + windows). The panel shows every file, why, its tokens and mode. Also exposed as the `get_context` MCP tool. | _mm:ss_ |
| Multi-file edit, unprompted (Task B) | From the task text alone the agent edits `src/flask/cli.py`, `tests/test_cli.py`, `docs/cli.rst`. | _mm:ss_ |
| Per-hunk review and undo (10) | `propose_edit` is a write tool, so TrueForge pauses for approval. We render hunks in the panel and in a VS Code diff editor with Accept/Reject CodeLenses per hunk. Only accepted hunks are written, as one `WorkspaceEdit` (Ctrl+Z works) plus an "Undo Last Agent Change" command. Rejected hunks are reported back to the model. | _mm:ss_ |
| Inline edit | Ctrl+I on a selection (or the enclosing function) runs a scoped TrueForge turn and reviews it the same way. | _mm:ss_ |
| Streaming and cancel | Token deltas stream live; Cancel aborts the stream, calls `sessions.cancel`, and discards staged proposals. | _mm:ss_ |
| Model fallback (10, Task C) | Errors are classified (rate limit, 5xx, unreachable, bad key, too large). Rate limits wait using the provider's retry hint; an unreachable endpoint or bad key switches models in about 1 s via `sessions.update`, then the turn is replayed on the same session history. A banner names both models; `git status` is unchanged because nothing unreviewed is ever written. | _mm:ss_ |
| Loop guard | Repeated identical read-only tool calls, or long exploration without an edit, get a steering note appended to the tool result (calls are never blocked). Added after Gemini repeated the same `search` four times in one Task B run. | — |
| TrueForge integration (10) | SDK sessions/turn streams, approval pause/resume (`@write`, `@destructive`), MCP connector with header auth, deferred tools with preload, model switching per session. | — |

## 3. Models (declared)

All models are configured in TrueForge as providers; the extension never calls a model API directly.

| Role | Model | Provider |
|---|---|---|
| Primary | `google-gemini/gemini-3-5-flash` | Gemini API |
| Fallback | `groq/qwen3-8-27b` | Groq (OpenAI-compatible) |
| Development only | scripted mock (`test/mock-flask-llm.mjs`) | local |

Rejected after testing: `gemini-3-8-flash` (no reply within 90 s on our key) and `groq/gpt-oss-120b`
(Groq rejects the `reasoning_content` field TrueForge sends back on the second call).

## 4. Evidence from rehearsals (headless driver, same code path as the panel)

| Run | Result |
|---|---|
| Task A, Gemini primary | Done: `helpers.py` edited after review, `FLASK_DEBUG=OFF` → `False`. |
| Task A, Gemini 429 mid-task | Retried with the provider's delay, switched to Groq, Groq finished the edit. |
| Task C, unreachable primary (ECONNREFUSED) | Switched to fallback in 1.2 s, banner shown, Task A completed, no write before the switch. |
| Task C, invalid key (401) | No retry, switched immediately (0.1 s), turn done. |
| Task B, Gemini free tier | Context report picked `cli.py` (whole), `test_cli.py`, `docs/cli.rst`, but the 20 requests/day ran out during exploration before any edit. Needs a paid key for the recorded take. |

## 5. Safety

- Nothing touches disk before review. Proposals are staged in memory keyed by a hash of the tool arguments;
  when TrueForge resumes the approved call, only accepted hunks are applied.
- The MCP server binds to 127.0.0.1 and requires a per-launch random bearer token, registered with TrueForge
  as header auth. Keys live only in the local TrueForge instance, never in the repo.

## 6. Limitations (honest)

- Free tiers are too small for agent work: Gemini allows about 20 requests/day per model, and Groq's free
  8K tokens/minute rejects agent turns. We rehearsed under these limits; see the video for the final runs.
- Retrieval is lexical + symbol based, not embedding based; a task phrased with no words from the code can
  miss files. Mentions (`@file`, `@symbol:name`) are the escape hatch.
- TrueForge approvals are allow/deny only, so per-hunk selection is applied by our tool, not by the harness.
- Sandbox features (Code Mode, skills) need bubblewrap/Daytona and are not used.

## 7. Built from scratch

No fork. Dependencies: `@truefoundry/trueforge-sdk`, `@modelcontextprotocol/sdk`, `diff` (BSD-3), `zod`.

## 8. Round 2

TrueForge has no native multi-model fallback. Our extension's classify → retry → switch → replay logic is a
natural harness PR: a `fallback_models` list on the agent spec handled inside the agent loop.
