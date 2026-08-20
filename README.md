# pi-trj-visualize

English | [简体中文](README.zh-CN.md)

A standalone, read-only visual explorer for Pi coding-agent sessions. It scans `~/.pi/agent/sessions` directly and renders the agent's main path, failed detours, backtracks, parallel tool waterfall, tokens, and cost on a zoomable timeline.

## Quick start

Requires Node.js `>=22.19.0`.

```bash
corepack enable
pnpm install
pnpm build
pnpm start
```

Open <http://127.0.0.1:4310>.

To install the CLI from the checkout:

```bash
pnpm link --global
pi-trj-visualize
```

## Highlights

- Recursively discovers Pi sessions without uploads.
- Reconstructs the Pi v3 append-only entry tree and visualizes only the selected branch.
- Groups child sessions through `parentSession`; Agent steps open the complete linked Subagent trajectory with a parent-session back button.
- Matches parallel tool results by `toolCallId`, independent of result order.
- Renders the parent and direct Subagent trajectories together on one real wall-clock axis, with distinct colors and Agent-call connectors.
- Chains consecutive failed attempts chronologically and draws only one recovery edge to the next successful step.
- Displays base64 image blocks from user/assistant/tool-result messages, with an image badge on the owning turn.
- English-first UI with a persistent `EN / 中文` switch shared by the session shell and trajectory iframe.
- Includes zoom/pan, filters, full-text search, detail panels, dark mode, and SVG/PNG export.
- Displays native Pi usage (input/output/reasoning/cache tokens and cost).
- Checks read-only every ten seconds and refreshes active sessions in the background.
- Uses opaque API IDs and never accepts arbitrary file paths.

## CLI

```text
pi-trj-visualize [options]
  --host <address>       default: 127.0.0.1
  --port <number>        default: 4310
  --sessions-dir <path>  override Pi's session directory
  --open                 open a browser
  -h, --help
```

The server respects `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, and `settings.json`'s `sessionDir`. A custom directory may use Pi's project-subdirectory layout or a flat collection of `.jsonl` files.

## Reading the timeline

- **Blue path:** successful parent-session checkpoints.
- **Cyan/orange/pink lanes:** direct Subagents aligned to the parent's real wall clock.
- **Rounded capsule:** one assistant step; width is its wall-clock duration.
- **Thin bars below a capsule:** parallel tool calls matched by `toolCallId`.
- **Red/gray dashed chain:** consecutive failures, empty searches, or wasteful retries in chronological order.
- **Gray recovery edge:** the last failed attempt reconnecting to the next successful step.
- **Purple `USER` badge:** this step owns a user input; click it to open the exact prompt.
- **Orange `▧` badge:** the owning step contains images; click the badge to open them.
- **`⏸` seam:** an idle interval longer than 60 seconds was compressed; displayed durations remain truthful.

With multiple lanes, use the wheel for vertical scrolling, `Ctrl/⌘ + wheel` for horizontal time zoom, and drag to pan.

## Supported Pi data

The parser targets Pi coding-agent JSONL **v3** and understands:

- `session` headers and `parentSession`
- append-only entry trees and active leaves
- user, assistant, tool-result, and bash-execution messages
- model/thinking-level changes, compaction, branch summaries, labels, and session info
- text and base64 image blocks

Parsing is read-only. A partial final JSONL line that is still being written is ignored until the next refresh.

## Development

```bash
pnpm check
pnpm e2e
```

Key modules:

```text
src/cli.ts                  CLI
src/server.ts               read-only HTTP/API server
src/session-repository.ts   discovery, summary cache, opaque IDs, parent/child links
src/pi-session.ts           Pi v3 tree parser and MazeData conversion
src/verdict.ts              tool verdicts and retry detection
src/web/index.html          session browser and EN/ZH shell
src/web/maze.html           SVG trajectory renderer and EN/ZH details
```

## Privacy and security

- The server only reads files and metadata; it never calls `SessionManager.open()` or rewrites sessions.
- `/api/session` accepts only opaque IDs from the scan index, never arbitrary paths.
- The default listener is `127.0.0.1` and validates loopback `Host` headers against DNS rebinding.
- Initial parsing uses at most six workers; the list cache stores summaries only and full trees use a four-entry LRU.
- Text tool results are capped at 5,000 characters and reasoning at 2,000 characters in browser payloads.

For Chinese documentation, see [README.zh-CN.md](README.zh-CN.md).

## Acknowledgements

The original SVG maze concept and parts of the browser renderer came from [lamost423/dsh-trace-compare](https://github.com/lamost423/dsh-trace-compare). This repository rebuilds that work as a standalone Pi session service with Pi v3 tree parsing, inline Subagent trajectories, image rendering, and read-only local access.

## License

MIT. See [NOTICE](NOTICE) for full attribution.
