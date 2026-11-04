# Hacker Terminal Enhanced

Browse and copy recent terminal commands and their output in an LLM-friendly
format. A two-pane history view — command list on the left, the selected
command's full text and captured output on the right — that you can place
wherever you like: the editor, the panel, either sidebar, or a separate window.

Pressing `Enter` copies the whole execution block for the selected command:

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

## Quick start

```bash
make build      # npm install + compile (tsc + bun webview bundle) + package *.vsix
make install    # build + install into VS Code and code-server
```

Open a terminal, press **`Ctrl+Alt+Shift+C`** (`Ctrl+Cmd+Shift+C` on macOS), and
pick a command with `↑` / `↓`. `Enter` copies it; `Alt+Z` toggles output wrap;
`Esc` closes the view.

## Docs

### [Usage](docs/important/usage/)

- [Usage, history and settings](docs/important/usage/history-and-settings.md): the full workflow, what history retains, capture modes, where the view can dock, and every `terminalEnhanced.*` setting.

### [Internals](docs/important/internals/)

- [Limitations](docs/important/internals/limitations.md): shell integration, `window` mode under code-server, TUI screens, `node:sqlite`, and restored terminals.
- [Build and source layout](docs/important/internals/source-layout.md): the build targets and the role of each source file.
- [Browser dev harness](docs/important/internals/browser-dev-harness.md): iterate on the webview in a plain browser against a read-only history mirror.
- [Restored terminals cannot be read](docs/important/internals/restored-terminal-limitation.md): why VS Code exposes no restored buffer to extensions, and what the extension persists instead.

### [Testing](docs/important/testing/)

- [How to test Hacker Terminal Enhanced](docs/important/testing/how-to-test.md): the committed Playwright suite, the popup/clipboard oracles, the scripts, and the environment overrides.

## Elsewhere

- Dated design logs: [`docs/plans/`](docs/plans/).
