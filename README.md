# Hacker Terminal Enhanced

Copy the last command and its output from the active terminal in an LLM-friendly
format — regardless of whether it succeeded or failed.

```text
# ----------------- TERMINAL EXECUTION: SUMMARY -----------------
- Working Directory: /home/user/project
- Exit Code: 0
- Started: 2026-09-08 14:32:01
- Ended:   2026-09-08 14:32:02
- Duration: 1.23s



# ----------------- TERMINAL EXECUTION: COMMAND -----------------
git status



# ----------------- TERMINAL EXECUTION: STDERR + STDOUT -----------------
On branch main
nothing to commit, working tree clean


```

## Usage

1. Open a terminal (shell integration must be enabled — enabled by default
   for supported shells).
2. Run any command.
3. Run **Hacker Terminal Enhanced: Copy Last Command and Output** from the Command
   Palette.
4. The formatted block is copied to your clipboard.

## Limitations

- Requires [shell integration](https://code.visualstudio.com/docs/terminal/shell-integration)
  to be enabled in the terminal (default for bash, zsh, fish, pwsh).
- Captures commands that run after the window starts. The extension activates
  at `onStartupFinished` (and on its command), so the first command of a
  session is tracked; the VS Code stable API offers no retroactive
  terminal-buffer reads.
- **Restored terminals have no history.** When VS Code is force-quit (or
  crashes) and session persistence revives the terminal, the last pre-restart
  command cannot be copied. Run any command in the restored terminal (even a
  no-op like `true`) and capture resumes normally. This is a hard ceiling of
  the extension API — see
  [`docs/important/restored-terminal-limitation.md`](docs/important/restored-terminal-limitation.md)
  for the full technical digression.
- Commands running in the background (e.g. `sleep 10 &`) may not have their
  output fully captured when the next command starts.

## Development

```bash
make build      # npm install + compile + package *.vsix
make install    # build + install into VS Code and code-server
```

## Testing

The end-to-end suite is Playwright-based and drives the **running code-server
workbench** over CDP (no browser is launched). All arrange/act goes through the
[REST Control](https://github.com/lamnguyenx/vscode-hacker-rest-control)
endpoint; Playwright only asserts the browser-visible result (status-bar echo,
clipboard, warning toasts). See the meta repo's
[`docs/important/how-to-test-all.md`](../../../docs/important/how-to-test-all.md)
for the model and the code-server/CDP topology.

```bash
# Prereqs: code-server running with this extension installed (`make install`),
# and the CDP browser reachable on CDP_PORT (9024 by default).

npm run typecheck:tests     # typecheck the E2E suite
npm run test:e2e            # or: make test-e2e
```

Environment overrides: `CDP_PORT` (browser CDP port), `HACKER_REST_CONTROL_PORT`
(REST Control port), `CODE_SERVER_URL` (workspace URL the tests expect).

The specs live in [`tests/playwright/`](tests/playwright/):
`terminal-enhanced.spec.ts` plus the shared `rest.ts` / `workbench.ts` helpers.
The first test reloads the window to force a fresh extension host, so it takes
longer than the others (~45s); it is the regression guard for the
`onStartupFinished` activation fix — without it, the first command of a session
is never captured.

Full setup, gotchas and known limits:
[`docs/important/how-to-test.md`](docs/important/how-to-test.md). Background and
the debugging log:
[`docs/plans/2026/09/29/2026-09-29-terminal-enhanced-activation-fix-and-playwright-e2e.md`](docs/plans/2026/09/29/2026-09-29-terminal-enhanced-activation-fix-and-playwright-e2e.md).