## fs-kanban

`fs-kanban` is a local orchestration board for running coding agents in parallel on a git-backed task board. Each task gets its own worktree and terminal session so supported CLI agents can work concurrently without stomping on each other.

### What It Does

- Creates and tracks task cards across backlog, in progress, review, and trash
- Launches agent sessions inside per-task git worktrees
- Streams live task state, terminal output, and review status into the web UI
- Supports task linking, auto-review actions, and project script shortcuts
- Keeps runtime state local under `~/.config/fs-kanban/` and `<project>/.fs-kanban/`

### Supported Release Surface

FS Kanban v2.0 is focused on local orchestration with Codex and Claude Code only.

- Task sessions run through local CLI launches in isolated worktrees
- The board, terminal, diff, hook, and websocket paths are local-first and file-backed
- Runtime settings now describe local agent selection and launch behavior only

Hosted provider settings, OAuth setup flows, MCP settings screens, and the old native Cline compatibility layer are no longer part of the supported release surface.

### Local Setup

Install dependencies:

```bash
npm run install:all
```

Build the app:

```bash
npm run build
```

Run it directly:

```bash
node dist/cli.js
```

Or create a global link so `fs-kanban` is available from any repo:

```bash
npm run link
fs-kanban
```

### Development

Runtime server:

```bash
npm run dev
```

Web UI:

```bash
npm run web:dev
```

Verification:

```bash
npm run release:verify
```

### Notes

- Run `fs-kanban` from the root of a git repository for the best experience.
- Task worktrees are created and managed automatically.
- Telemetry and external feedback integrations have been removed from this fork.
- Release builds are produced and validated with `npm run release:verify`.

### License

[Apache 2.0](./LICENSE)
