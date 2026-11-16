# Forge Agent — Product Requirements Document

**Team:** teamvibez · TM-F8AE7773192 (competition ID TFF-51725D9BE94F)
**Repo:** https://github.com/childbloomenterprise/forge-agent
**Competition:** TrueFoundry Forge-a-thon, Techfest IIT Bombay
**Round 1 deadline:** 20 Nov 2026, 23:59 IST · Results 30 Nov · Finals 16–18 Dec at IIT Bombay
**Status date:** 16 Nov 2026

---

## 1. Context: what this competition is

This is not an ideas contest. The product, the target repository and the test tasks are all fixed. Every team builds the
same thing: a **VS Code extension that is a coding agent whose agent loop runs on TrueForge**
(https://github.com/truefoundry/trueforge, TrueFoundry's open-source agent harness). Judges watch a 4-minute video of three
fixed tasks on `pallets/flask` 3.1.3 (commit `22d92470`, about 17k lines, larger than a context window) and score against a 100-point
rubric with fixed anchors. **Where we sit between two anchors, the lower one applies.** So the strategy is simple: hit the
top anchor on every line and make each behaviour obvious on screen.

**Challenge question (from the brief):** build an editor-native agent on TrueForge that finds the right code in a repo
larger than the context window, makes a multi-file change the user never spelled out, shows every change for review before
it touches disk, and keeps working when the model fails.

**Fairness rule:** points are for what the extension does, not how smart the model is. Organisers may make shortlisted teams
re-run Task A live **on a model of their choice**, so the extension must work with any TrueForge-configured model.

## 2. Hard eligibility rules (pass/fail, checked first)

| Rule | How we comply |
|---|---|
| Extension is a TrueForge client (sessions and turns via SDK/HTTP, streamed events rendered in the editor) | `@truefoundry/trueforge-sdk`; `src/trueforge/runner.ts` |
| Editor capabilities exposed to the agent as **MCP tools**; the agent decides what to read or change | MCP server inside the extension; `src/mcp/` |
| TrueForge in local mode (`npx @truefoundry/trueforge@latest`) | README setup |
| Model configured in TrueForge; **the extension never calls a model provider directly** | Providers registered by `scripts/setup-providers.sh` |
| Video shows the TrueForge session (turns and tool calls) during Task B | Planned in `docs/DEMO.md` |
| **Repo contains the agent definition used** | **GAP**: the spec is built in code (`runner.ts` `spec()`); it must also be committed as a JSON file and the README must say how to load it |
| No API keys committed; example config shipped | `.env.example`; full git history checked |
| Declare fork point (or "from scratch"), keep licences | From scratch, MIT. **GAP**: state "from scratch" explicitly in the README |
| Not allowed | A hosted backend, accounts, Marketplace publishing, tab completion, training models (out of scope, earns no points) |

## 3. The three fixed tasks (exact wording, do not paraphrase)

| Task | Instruction given to the agent | On-screen verification |
|---|---|---|
| **A. Inline edit** | Open `src/flask/helpers.py`, **select `get_debug_flag`**, press the inline-edit key (Ctrl+I) and type: *"Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false."* Review and accept. | `FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` prints `False` |
| **B. Agent mode** (3+ files, none named) | In the agent panel: *"Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "\*\*\*". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands."* Review hunks, accept. **Show the TrueForge session.** | `pytest tests/test_cli.py -q` passes; run `flask config` on an app and show the masked JSON; the diff touches at least 3 files (expected: `src/flask/cli.py`, `tests/test_cli.py`, `docs/cli.rst`) |
| **C. Resilience** | Configure TrueForge with an unreachable endpoint or invalid key, then repeat Task A. | Editor stays responsive; clear message, or a second model takes over automatically; `git status` shows no files changed |

## 4. Scoring rubric and our target

| # | Criterion | Pts | Top anchor (what we must show) | Our status |
|---|---|---|---|---|
| A1 | Inline edit | 10 | Diff rendered in the editor with **per-hunk** accept/reject | Built (Ctrl+I, diff editor + CodeLens per hunk). Not yet clicked through in VS Code |
| A2 | Agent mode | 10 | Discovers and edits 3+ files unprompted (Task B) | Tool loop built. **Task B never completed** (model quota) |
| A3 | Streaming and cancellation | 10 | Immediate cancel, workspace stays consistent | Built and tested headless (cancel in ~10 ms, staged edits discarded) |
| B1 | Context assembly | 15 | Retrieval with a size budget, strategy in write-up, **visible in Task B** (which files and why) | Built: Context report panel; picks `cli.py`, `test_cli.py`, `docs/cli.rst` for Task B |
| B2 | Diff safety | 10 | Per-hunk review + working undo, shown on screen | Built (in-memory staging, `WorkspaceEdit` so Ctrl+Z works, "Undo Last Agent Change") |
| B3 | Resilience | 10 | Automatic fallback to a second configured model, no user action, workspace unchanged | Built and verified: unreachable → switch in 1.2 s, bad key → 0.1 s, real Gemini 429 → Groq finished |
| B4 | TrueForge depth | 10 | MCP tools + TrueForge approval drives review **+ one context-engineering feature (subagents, deferred tools, Code Mode, compaction) visible in the session** | First two done. **GAP**: all our tools are `preload: true`, so deferred loading isn't actually used yet. Need a deferred tool set or an explorer subagent that shows up in the session |
| C1 | Video | 10 | A, B, C in order, each verified on screen | Script ready; not recorded |
| C2 | Write-up | 15 | Architecture, context strategy, model setup, trade-offs + accurate timestamped scorecard + honest limitations | Draft exists. **GAP**: must use the 8 mandated headings (section 9) and be a PDF |

## 5. Users and use cases

- **Primary user (judge/developer):** opens a large repo in VS Code and asks for a change, either inline on a selection or in the
  agent panel. Expects to see what the agent looked at, review every hunk, undo, and cancel at any time.
- **Organiser re-run:** swaps in an arbitrary model in TrueForge and repeats Task A. It must still work.

## 6. Product requirements

### 6.1 Functional
1. **Agent panel** (sidebar webview): chat input, live token streaming, tool-call log, thread/turn status, Cancel, New session, model shown in the status bar.
2. **Inline edit:** Ctrl+I on a selection (or the enclosing function when nothing is selected), then an instruction box. A scoped TrueForge turn returns a diff in the editor with per-hunk Accept/Reject.
3. **MCP editor tools** (served by the extension on 127.0.0.1 with a per-launch bearer token):
   `read_file`, `list_dir`, `search` (ripgrep), `find_symbol` (VS Code symbol providers), `get_context`,
   `propose_edit` (write → TrueForge approval), `run_command` (destructive → approval).
4. **Context engine:** IDF-weighted keyword hits + filename + symbol-definition matches, test/doc companion files, `@file` and
   `@symbol:name` mentions, packed into a token budget (default 16k; primary file whole within 65% of it). A visible
   **Context report** lists each file, the reason, its tokens, and whether it was included in full, as snippets, or omitted.
5. **Diff review:** `propose_edit` stages the change in memory; TrueForge pauses for approval; hunks are shown in the panel and in
   a diff editor; only accepted hunks are written, as one undoable `WorkspaceEdit`; rejected hunks are reported to the model.
6. **Resilience:** classify errors (rate limit, 5xx, unreachable, bad key, too large). Retry with the provider's delay where it makes sense;
   otherwise switch to the next model in `forgeAgent.models` via `sessions.update` and replay on the same session. A banner names both models.
7. **Loop guard:** repeated identical read-only calls get a steering note; after 14 exploration calls with no edit, read-only tools pause until the model proposes an edit.
8. **Cancel:** aborts the stream, calls `sessions.cancel`, discards staged proposals. Nothing unreviewed is ever written.

### 6.2 Non-functional
- Editor never blocks. Cancel takes effect immediately.
- Works with any TrueForge model; no provider-specific code paths.
- Secrets live only in the local TrueForge instance or a local `.env`; never in the repo.
- README setup works from a clean clone.

## 7. Architecture

```
VS Code extension (TypeScript)                    TrueForge (local, :8790)
 ├─ Agent panel / inline edit  ◀── SDK turn stream ───  agent loop, session history
 ├─ Review UI (panel + diff)   ─── tool approvals ───▶  @write / @destructive gating
 ├─ Fallback controller        ─── sessions.update ──▶  model per session
 ├─ Context engine (+ report)
 └─ MCP server 127.0.0.1+token ◀────── MCP/HTTP ──────  calls editor tools
                                                         │
                                         model providers (Gemini, Groq, any OpenAI-compatible)
```

| Area | Files |
|---|---|
| Activation, commands, inline edit, wiring | `src/extension.ts` |
| TrueForge session/turn/fallback logic | `src/trueforge/runner.ts`, `instructions.ts`, `register.ts` |
| MCP server + tools + loop guard | `src/mcp/server.ts`, `tools.ts`, `loopGuard.ts` |
| Context retrieval | `src/context/engine.ts` |
| Staging, hunks, review UI | `src/edits/staging.ts`, `reviews.ts`, `reviewUi.ts` |
| Webview | `src/panel/AgentPanel.ts`, `media/panel.js`, `media/panel.css` |
| Tests, headless driver, scripted mock model | `test/*.test.ts`, `test/headless.ts`, `test/mock-flask-llm.mjs` |

About 2,000 lines in total. Unit tests: 14 passing (hunks, replacement validation, retry classification, context ranking, loop guard).

**Key TrueForge facts learned the hard way**
- Start it with `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]'`, or it blocks the localhost MCP server.
- MCP tools are deferred by default (the model only sees list/get/call meta-tools); we set `preload: true`.
- Approval is allow/deny only and can't carry edited arguments, so per-hunk selection is applied inside our `propose_edit` tool.
- No native model fallback in TrueForge. We built it in the extension; it is our planned Round 2 PR.
- Session spec shape: `agent: { spec }` (no `type`).

## 8. Models

| Role | Model (TrueForge name) | Provider | Cost so far |
|---|---|---|---|
| Primary | `google-gemini/gemini-3-5-flash` | Gemini API | $0 (free tier) |
| Fallback | `groq/qwen3-8-27b` | Groq | $0 (free tier) |
| Dev/testing | scripted mock (`test/mock-flask-llm.mjs`) | local | $0 |

Rejected: `gemini-3-8-flash` (no reply within 90 s), `groq/gpt-oss-120b` (rejects the `reasoning_content` field TrueForge sends back).

**Main blocker:** the Gemini free tier allows about **5 requests/minute and 20/day** per model. Task B needs about 20–30 requests, so it runs out
mid-exploration. Groq's free tier (8K tokens/min) rejects full agent turns as too large. **Fix: enable billing on the
Gemini key's Google Cloud project (estimated under $5 total).** Switching user-facing models = edit `forgeAgent.models` in settings.

## 9. Required write-up (PDF, 1–3 pages, these 8 headings in this order)

1. Team (members, college or employer, GitHub handles)
2. Starting point ("from scratch")
3. Architecture on TrueForge (how we talk to it, which MCP tools, which harness features and why)
4. How context is selected (strategy + budget)
5. Model setup (models, where they ran, approximate cost, how to switch)
6. Scorecard (one row per criterion: video timestamp + one-line claim)
7. Tools used (including AI coding assistants, e.g. Devin; this costs no points)
8. Known limitations and what we'd do with another month

## 10. Required video (max 4 min, public link)

Screen recording with the editor visible. **A, B, C in that order**, each followed by its verification; show the TrueForge session briefly during
Task B. Model waiting time may be cut, but **never cut between giving an instruction and the diff appearing.** YouTube unlisted or a Google Drive
link anyone can view. Shot list: `docs/DEMO.md`.

## 11. Status and remaining work

**Done:** public repo; TrueForge integration; MCP tools; context engine + report; per-hunk review (panel and diff editor); undo; inline
edit; streaming; cancel; fallback (verified); loop guard; `.vsix` packaging; draft write-up; demo script.

| # | Remaining item | Owner | Blocks |
|---|---|---|---|
| 1 | Enable Gemini billing | Team (account owner) | Task B, video |
| 2 | Get Task B passing with the **exact** wording; show `flask config` masked output | Devin | Video |
| 3 | Commit the agent definition JSON + README "how to load it" + "from scratch" | Devin | Eligibility |
| 4 | Make one context-engineering feature real and visible in the session (deferred tools or explorer subagent) | Devin | B4 = 10 |
| 5 | Rehearse Task A through **Ctrl+I inline edit** (not agent mode) with the exact wording | Devin | A1, video |
| 6 | Click through the VS Code screens: review CodeLens, Ctrl+I, Cancel, Undo | Devin / team | Video |
| 7 | Record the video from `docs/DEMO.md`; upload publicly | Team | Submission |
| 8 | Rewrite the write-up to the 8 headings, add timestamps, export to PDF | Devin + team (team details) | Submission |
| 9 | Fill the submission form (https://forms.gle/htyWGFJRBgsg3qmx6) with the 3 public links | Team | — |
| 10 | Prepare for the 10-min code walkthrough + live Task A on an organiser-chosen model | Whole team | Shortlist |
| 11 | Rotate the Gemini and Groq keys after the competition (they appeared in chat) | Team | Security |

**Definition of done for Round 1:** all three tasks pass on screen in one recording, the repo README works from a clean clone, and the PDF
has the 8 headings with real timestamps.

## 12. Risks

| Risk | Mitigation |
|---|---|
| Free-tier quota kills Task B during recording | Paid Gemini for the recording; Groq/mock as fallback for Task C only |
| Model loops instead of editing | Upfront context pack, batching instructions, loop guard |
| Organisers' model has weak tool calling | All tools preloaded; plain instructions; tested on 2 providers + mock |
| Team can't explain the code in the walkthrough | Each member reads this PRD + the files in section 7; run the headless driver once |

## 13. Round 2 (finals) head start

Finals require a PR to TrueForge itself. Candidate: **native model fallback** in the harness (a `fallback_models` list on the agent spec,
handled inside the loop). It is exactly what our extension does today and TrueForge's docs list it as planned.

## 14. How to run it (for a new teammate)

```bash
OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]' npx @truefoundry/trueforge@latest   # TrueForge on :8790
git clone https://github.com/childbloomenterprise/forge-agent && cd forge-agent
cp .env.example .env    # add GEMINI_API_KEY / GROQ_API_KEY (never commit)
./scripts/setup-providers.sh
npm install && npm run build && npm test
# VS Code: open this folder, press F5, then open a flask 3.1.3 checkout in the new window
```
