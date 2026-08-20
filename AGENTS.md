# AGENTS.md

Standalone Pi coding-agent session visualizer.

- `src/cli.ts` starts the read-only HTTP server; default bind is `127.0.0.1:4310`.
- `src/session-repository.ts` recursively scans the configured Pi session root and exposes only opaque IDs.
- `src/pi-session.ts` parses Pi JSONL v3 as an append-only tree, resolves a selected leaf, and converts that branch to `MazeData`.
- `src/web/index.html` is the session browser shell; `src/web/maze.html` is the SVG renderer embedded in an iframe.
- `src/verdict.ts` is the server-side tool verdict and retry classifier; `scripts/build-web.mjs` copies the self-contained browser assets.
- The application must remain read-only: do not use `SessionManager.open()` because it may migrate and rewrite old sessions.
- Verify with `corepack pnpm check`; use Playwright against a built, running server for visual changes.
