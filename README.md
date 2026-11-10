# Forge Agent

A coding agent for VS Code whose agent loop runs on [TrueForge](https://github.com/truefoundry/trueforge).
Built for the TrueFoundry Forge-a-thon (Techfest 2026–27).

The extension is a thin client. TrueForge runs the agent loop (model calls, tool selection, approvals, subagents,
context compaction). The extension hosts an MCP server that gives TrueForge access to the editor, and it renders
streaming output, per-hunk diff review and fallback status in VS Code.

```
 VS Code extension                                   TrueForge (localhost:8790)
 ┌───────────────────────────────┐   SDK: sessions, ┌──────────────────────────┐
 │ Agent panel (webview)         │◀─ turn streams ──│ agent loop               │──▶ Gemini (primary)
 │ diff review / undo / cancel   │── approvals ────▶│ tool approval (@write)   │──▶ Groq (fallback)
 │ model fallback controller     │                  │ deferred tools, subagents│
 │ MCP server 127.0.0.1:9317 ◀───┼── MCP (HTTP) ────│ compaction               │
 └───────────────────────────────┘                  └──────────────────────────┘
```

## Status

| Capability | State |
|---|---|
| Agent panel with token streaming and cancel | done |
| Editor tools over MCP: `read_file`, `list_dir`, `search`, `find_symbol`, `get_context`, `propose_edit`, `run_command` | done |
| Edits gated by TrueForge tool approval; per-hunk accept/reject; native undo + "Undo Last Agent Change" | done (panel card + diff editor CodeLenses) |
| Retry with provider retry-hint, then automatic model fallback with session replay; unreachable/bad-key models switch in ~1 s | done |
| Inline edit (Ctrl+I / editor context menu) on the selection or enclosing function, reviewed in the diff editor | done |
| Context engine: keyword + symbol + filename ranking, test/doc companions, `@file`/`@symbol:name`, token budget, visible "why these files" report | done |

## Setup

Requirements: Node 20+, VS Code 1.90+, `ripgrep` on `PATH`.

1. Start TrueForge. Local MCP servers are on 127.0.0.1, which TrueForge's SSRF guard blocks by default, so allow it:
   ```bash
   OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]' npx @truefoundry/trueforge@latest
   ```
2. Register model providers (keys stay in your local TrueForge, never in this repo):
   ```bash
   cp .env.example .env   # add GEMINI_API_KEY and/or GROQ_API_KEY
   ./scripts/setup-providers.sh
   ```
   Any TrueForge model works; set the chain in the `forgeAgent.models` setting.
3. Build and run the extension:
   ```bash
   npm install
   npm run build
   ```
   Open this folder in VS Code and press F5, then open the target project (e.g. `pallets/flask@3.1.3`) in the
   Extension Development Host. Or `npm run package` and install the `.vsix`.

## Settings

| Setting | Default | |
|---|---|---|
| `forgeAgent.trueforgeUrl` | `http://localhost:8790` | TrueForge server |
| `forgeAgent.models` | `["google-gemini/gemini-3-5-flash", "groq/qwen3-8-27b"]` | Primary first, then fallbacks |
| `forgeAgent.mcpPort` | `9317` | Local MCP port (falls back to a random port if taken) |
| `forgeAgent.contextBudgetTokens` | `12000` | Context budget for retrieval |

## How context retrieval works

Before each request the extension builds a context pack and shows it in the panel:

1. Keywords are taken from the request (stop words removed, light stemming) and searched with ripgrep at word starts.
2. Files are scored by keyword frequency weighted by rarity (IDF), filename matches and symbol definitions
   (`def`/`class`/`function`). Tests, docs and changelogs are down-weighted as primary hits.
3. Each top source file pulls in its companions (`tests/test_<name>.py`, `docs/<name>.rst`) so the agent edits code,
   tests and docs together. `@path` and `@symbol:name` mentions are always included.
4. Files are packed into `forgeAgent.contextBudgetTokens`: whole file when small, otherwise an outline plus the
   best-matching windows, else omitted. The report lists every file with its reason, token count and mode.

The same retrieval is exposed to the agent as the `get_context` MCP tool.

## Rate limits

Free tiers are tight: Gemini's free tier allows about 20 requests per day per model, and Groq's free tier rejects
requests over 8K tokens per minute. The agent is instructed to batch independent tool calls into one step, and the
extension waits on 429s (using the provider's retry hint) before falling back.

## How safety works

- `propose_edit` is annotated as a write tool, and the session spec sets `require_approval_for_tools: ["@write", "@destructive"]`,
  so TrueForge pauses the turn before any edit or command runs.
- On the pause, the extension computes hunks from the current buffer and shows them for review (plus a side-by-side diff).
  The decision is keyed by a hash of the tool arguments; when TrueForge resumes and calls the tool, only accepted hunks are written,
  through a single `WorkspaceEdit` (so Ctrl+Z works), and the model is told which hunks were rejected.
- Cancel aborts the stream, calls `sessions.cancel`, and discards pending proposals. Nothing unreviewed is ever on disk.
- The MCP server binds to 127.0.0.1 and requires a per-launch bearer token, which is registered with TrueForge as header auth.

## Development

```bash
npm run typecheck
npm test                      # unit tests (hunks, replacements, retry policy, context ranking)
CONTEXT_BUDGET=12000 node out/test/headless.mjs <workspace> "<task>" [model,...]   # headless end-to-end run against TrueForge, auto-accepting hunks
```

## Licence

MIT. See [LICENSE](LICENSE).
