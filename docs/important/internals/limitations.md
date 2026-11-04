# Limitations

Known limits of shell-integration capture, full-screen TUIs, `node:sqlite`, and restored terminals.

- Requires [shell integration](https://code.visualstudio.com/docs/terminal/shell-integration)
  to be enabled in the terminal (default for bash, zsh, fish, pwsh).
- **`window` mode needs a desktop build.** Under code-server / a browser,
  VS Code cannot move an editor into its own OS window, so it falls back to the
  editor area.
- **Full-screen TUIs are captured as their visible screen, not their session
  history.** A TUI repaints in place on the alternate screen; the extension
  snapshots the last screen it displayed (e.g. tig's log view, gdu's summary)
  rather than reconstructing keystroke-by-keystroke navigation.
- **VS Code's shell-integration data stream silently drops some commands'
  output entirely** (inside VS Code itself — most notably `docker logs -f`).
  The emulator path captures these and the output of ultra-fast builtins.
  Commands running in the background (e.g. `sleep 10 &`) may still miss output
  once the next command starts.
- The history database uses the built-in **`node:sqlite`**, which requires an
  extension-host **Node ≥ 22.5**. The reference stack (code-server 4.x) runs
  Node 24; on an older host the extension shows an error and history is
  disabled. This is why the extension does not support Node 20-era desktop
  VS Code.
- **Restored terminals:** VS Code cannot expose a restored terminal's buffer to
  extensions, but the extension's own persisted history means your last
  commands are still available after a reload or crash. See
  [`docs/important/internals/restored-terminal-limitation.md`](restored-terminal-limitation.md).
