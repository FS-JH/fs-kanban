# FS Kanban Architecture

## Purpose

FS Kanban is a local orchestration board for running coding agents in parallel. The core job of the app is to turn board actions into task sessions, keep those sessions attached to git worktrees, and stream live state back to the UI.

The current runtime focuses on two primary coding agents:

- Codex
- Claude Code

Other command-driven agents can still fit the terminal model, but the documented path and the active onboarding flow center on those two.

## High-Level Stack

FS Kanban is split into a few layers:

- CLI entrypoint and command parsing in `src/cli.ts`
- runtime orchestration in `src/trpc/` and `src/server/`
- process and worktree management in `src/terminal/` and `src/workspace/`
- agent launch routing in `src/agents/`
- shared runtime types and validation in `src/core/`
- board and detail UI in `web-ui/src/`

The board is intentionally local-first. It uses the user’s current git repository, a runtime server, and websocket updates rather than an external service.

## Runtime Flow

When the CLI starts, it resolves the current workspace, loads runtime config, and launches the local server. The server exposes the board, task-session procedures, workspace state, and hook ingestion paths.

Task execution works like this:

1. The UI or CLI creates or updates a task card.
2. `runtime-api.ts` validates the request and asks the workspace and terminal layers to prepare the task.
3. The terminal layer starts a session in the task’s git worktree.
4. Session summaries and hook events are pushed into the runtime state hub.
5. The browser receives websocket updates and refreshes the board and detail view.

That flow is shared by board actions, sidebar actions, and hook-driven transitions.

## Agent Launch

The agent launch layer in `src/agents/` is responsible for choosing which binary to run and how to route a task.

Current responsibilities:

- `engine-adapter.ts` defines the shape of a runnable agent adapter
- `codex-adapter.ts` runs Codex-style CLI sessions
- `claude-adapter.ts` runs Claude Code sessions
- `engine-router.ts` picks a provider for a role and applies fallback and cooldown rules
- `run-status.ts` tracks the live state model that the UI can render

The router keeps the implementation simple:

- roles map to provider candidates
- providers can be disabled or cooled down independently
- a successful provider run short-circuits the fallback chain
- failures can fall through to the next available provider

The intent is to keep the agent abstraction narrow. FS Kanban should orchestrate agents, not duplicate their internals.

## Worktrees And Sessions

Task sessions run inside git worktrees so parallel work does not conflict with the main checkout.

Responsibilities are split like this:

- `src/workspace/task-worktree-path.ts` computes task worktree locations
- `src/workspace/initialize-repo.ts` prepares repositories for task execution
- `src/terminal/session-manager.ts` owns terminal lifecycle and PTY details
- `src/terminal/agent-registry.ts` detects installed command-line agents

The terminal session is the execution primitive for task work. That keeps the runtime consistent across platforms and avoids special cases in the UI.

## State And Streaming

The runtime state hub is the fanout point for live updates. It gathers terminal summaries, workspace metadata, task transitions, and hook events, then broadcasts normalized websocket messages to the browser.

The state model is designed around board continuity:

- backlog cards stay editable and linkable
- in-progress cards represent active sessions
- review cards represent work ready to inspect
- trash is the recovery path for completed or cleaned-up worktrees

The UI does not talk directly to terminal internals. It consumes the normalized state stream and renders the latest summary it has.

## Configuration

Persistent runtime preferences live under the user config directory and project config directory.

- global config: `~/.config/fs-kanban/config.json`
- project config: `.<project>/.fs-kanban/config.json`

`src/config/runtime-config.ts` owns the file format and defaults. It stores board preferences such as:

- selected agent
- shortcuts
- prompt templates
- task-review notification preferences

It should not be used for provider secrets or external telemetry state.

## Web UI

The web app lives under `web-ui/src/` and is a thin presentation layer over the runtime APIs.

Important surfaces:

- `web-ui/src/App.tsx` wires the main board and detail layout
- `web-ui/src/components/` contains the board, detail, and settings panels
- `web-ui/src/hooks/` contains most of the application behavior and state binding

The UI focuses on:

- creating and organizing tasks
- linking dependent tasks
- starting sessions
- reviewing diffs and terminal output
- configuring the selected coding agent

## Compatibility Notes

FS Kanban still contains some compatibility shims and legacy names while the fork completes its migration away from the upstream runtime model.

That includes:

- a small `src/cline-sdk/` compatibility layer
- a few `Cline`-named types and test helpers
- legacy environment variable names that remain for compatibility with existing tooling

Those names should be treated as migration residue, not the main architecture.

## What To Change First

When changing runtime behavior, prefer this order:

1. update the runtime contract in `src/core/`
2. update the runtime server or router in `src/trpc/` and `src/server/`
3. update the terminal or workspace layer if session behavior changes
4. update the UI hooks and components that render the new state
5. update tests alongside the code change

That keeps the runtime stable while the board and session model evolve.

## Verification

The practical checks for this architecture are:

- `npm run check`
- `npm run build`
- `npm --prefix web-ui run test`

If one of those fails, the failure is usually in a contract or integration boundary rather than a single component.
