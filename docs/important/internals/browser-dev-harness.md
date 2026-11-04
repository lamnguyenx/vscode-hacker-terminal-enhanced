# Browser dev harness

Iterate on the webview in a plain browser against a read-only mirror of the history database.

Iterate on the panel in a plain browser (normal devtools), hot-reloading on
save, against a **read-only mirror** of your real history DB:

```bash
make dev-webview            # or: npm run dev:webview  → http://localhost:5199
make dev-webview-docker     # same, in the pinned Bun container
```

The container service lives in the **meta repo's** `docker-compose.yml`
(alongside `code-server`) as `lamnguyenx.hacker-terminal-enhanced-webview-dev`:
run `docker compose up -d lamnguyenx.hacker-terminal-enhanced-webview-dev` from
the meta repo root.

It serves the real `media/popup.*` (rebuilt by `bun build --watch`) with the
same document markup and message protocol as the extension, so the browser page
cannot drift from the real webview. Editing `src/webview/**` or
`media/popup.css` reloads the page; running commands in code-server updates the
list/output live. Actions are fully interactive (`↑`/`↓`, `Enter` to copy); only
DB writes are disabled. Env overrides: `WEBVIEW_DEV_PORT`, `HTE_DB`,
`HTE_META_ROOT`.

It mirrors the SQLite file the extension writes, so the **code-server workbench
tab must be connected** — its extension host has to be running to capture
commands (reload the tab after a code-server restart). The page resyncs on
connect and the server polls the DB every 500 ms, so anything captured shows up
within a beat.
