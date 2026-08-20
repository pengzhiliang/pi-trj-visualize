# pi-trj-visualize

A standalone, read-only visual explorer for Pi coding-agent sessions. It scans `~/.pi/agent/sessions` directly and renders the agent's main path, failed detours, backtracks, parallel tool waterfall, tokens, and cost on a zoomable timeline.

## Start

```bash
corepack enable
pnpm install
pnpm build
pnpm start
```

Open <http://127.0.0.1:4310>.

## Highlights

- Recursively discovers Pi sessions without uploads.
- Reconstructs the Pi v3 append-only entry tree and visualizes only the selected branch.
- Groups child sessions through `parentSession`; Agent steps open the complete linked Subagent trajectory with a parent-session back button.
- Matches parallel tool results by `toolCallId`, independent of result order.
- Renders the parent and direct Subagent trajectories together on one real wall-clock axis, with distinct colors and Agent-call connectors.
- Chains consecutive failed attempts chronologically and draws only one recovery edge to the next successful step.
- Displays base64 image blocks from user/assistant/tool-result messages, with an image badge on the owning turn.
- Includes zoom/pan, playback, filters, full-text search, detail panels, dark mode, and SVG/PNG export.
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

The server respects `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, and `settings.json`'s `sessionDir`.

## Development

```bash
pnpm check
pnpm e2e
```

See the Chinese [README](README.md) for the complete feature and architecture documentation.

## Acknowledgements

The original SVG maze concept and parts of the browser renderer came from [lamost423/dsh-trace-compare](https://github.com/lamost423/dsh-trace-compare). This repository rebuilds that work as a standalone Pi session service with Pi v3 tree parsing, inline Subagent trajectories, image rendering, and read-only local access.

## License

MIT. See [NOTICE](NOTICE) for full attribution.
