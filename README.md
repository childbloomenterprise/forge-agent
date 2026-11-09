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
| Editor tools over MCP: `read_file`, `list_dir`, `search`, `find_symbol`, `propose_edit`, `run_command` | done |
| Edits gated by TrueForge tool approval; per-hunk accept/reject; native undo + "Undo Last Agent Change" | done (panel review) |
| Retry with provider retry-hint, then automatic model fallback with session replay | done |
| Inline edit (Ctrl+I) with in-editor diff | planned |
| Context engine: repo map + keyword retrieval + `@file`/`@symbol`, token budget, visible report | planned |

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
npm test                      # unit tests (hunks, replacements, retry policy)
node out/test/headless.mjs <workspace> "<task>" [model,...]   # headless end-to-end run against TrueForge, auto-accepting hunks
```

## Licence

MIT. See [LICENSE](LICENSE).
