# Terminal Enhanced

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
3. Run **Terminal Enhanced: Copy Last Command and Output** from the Command
   Palette.
4. The formatted block is copied to your clipboard.

## Limitations

- Requires [shell integration](https://code.visualstudio.com/docs/terminal/shell-integration)
  to be enabled in the terminal (default for bash, zsh, fish, pwsh).
- Only captures commands that are executed **after** the extension activates.
  The VS Code stable API does not offer retroactive terminal-buffer reads.
- Commands running in the background (e.g. `sleep 10 &`) may not have their
  output fully captured when the next command starts.

## Development

```bash
make build      # npm install + compile + package *.vsix
make install    # build + install into VS Code and code-server
```