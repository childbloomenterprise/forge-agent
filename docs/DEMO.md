# Demo video script (max 4:00)

Setup before recording: TrueForge running with `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]' npx @truefoundry/trueforge@latest`,
providers registered (`scripts/setup-providers.sh`), Flask 3.1.3 open in VS Code with a clean `git status`, terminal visible.

| Time | Shot | Rubric |
|---|---|---|
| 0:00–0:15 | Title, architecture diagram from the write-up. Say: agent loop on TrueForge, tools over MCP. | B4 |
| 0:15–0:45 | **Task A.** Type the task in the panel. Show the Context report (files, reasons, tokens, mode) and streamed tokens. | B1, streaming |
| 0:45–1:10 | Review card + diff editor: accept the code hunk, show the docstring hunk, accept. Run shows `FLASK_DEBUG=off` → `False`. Ctrl+Z to show native undo, then redo. | B2 |
| 1:10–2:30 | **Task B.** Task text only, no file names. Context report lists `cli.py`, `test_cli.py`, `docs/cli.rst`. Review each file; reject one hunk to show per-hunk control, then let the model re-propose. Terminal: `flask --help` shows the command, `flask config` masks secrets, `pytest tests/test_cli.py -q` passes. `git diff --stat` shows 3+ files. | Task B, B2 |
| 2:30–2:45 | Ctrl+I inline edit on one function, in-editor diff with CodeLens Accept/Reject. | inline edit |
| 2:45–3:00 | Start a long task, press Cancel: stream stops, "nothing unreviewed was written", `git status` clean. | cancel |
| 3:00–3:40 | **Task C.** Settings: set primary to the broken endpoint (or invalid key). Rerun Task A: warning banner, "switched to fallback …; workspace unchanged", status bar model changes, task completes. `git status` before the accept is clean. | B3 |
| 3:40–4:00 | TrueForge UI/session showing the same session history across the model switch. Close on the scorecard. | B4 |

After recording, fill the `_mm:ss_` column in `WRITEUP.md` with these timestamps.
