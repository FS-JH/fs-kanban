## FS Kanban Implementation Plan

### Goal

Fork `cline/kanban` into `fs-kanban` and turn it into a personal orchestration board for Codex and Claude Code. Preserve the existing board, worktree, terminal, tRPC, and websocket shell where it is already solid. Remove all Cline-specific code paths, all telemetry, and all `@clinebot/*` dependencies. Port the useful Agent Runtime concepts into that shell instead of rebuilding the app from scratch.

### Validated Findings

- The upstream code at `v0.1.48` matches the original plan's broad direction.
- The upstream runtime already contains substantial infrastructure:
  - PTY-backed task sessions
  - worktree lifecycle management
  - runtime websocket state streaming
  - turn checkpoints and diff plumbing
- Phase 0 needs a broader cleanup than the original draft listed. In addition to source imports, it must remove:
  - `scripts/upload-sentry-sourcemaps.mjs`
  - `@sentry/cli`
  - `vitest.config.ts` aliases for `@clinebot/*`
  - `biome.json` references to `@clinebot/*`
  - `.env.example`, docs, and test references that keep telemetry or Cline strings alive
- The original plan's Phase 1 should be adjusted:
  - keep `src/workspace/task-worktree.ts` as the worktree authority
  - keep the existing tRPC and websocket transport shell
  - replace Cline-specific execution behind `src/trpc/runtime-api.ts`
  - migrate session state incrementally, not by replacing the runtime wholesale

### Guardrails

- No outbound network calls to third-party telemetry or Cline services.
- No `@clinebot/*` dependencies or imports.
- No dynamic third-party script injection.
- No destructive worktree cleanup without explicit confirmation.
- No changes to task worktree authority outside the existing worktree module.

### Phase 0: Sanitize, Rebrand, Verify

#### Remove hard dependencies and phone-home vectors

- Delete:
  - `src/cline-sdk/`
  - `src/telemetry/`
  - `src/update/auto-update.ts`
  - `web-ui/src/telemetry/`
  - `web-ui/src/hooks/use-featurebase-feedback-widget.ts`
  - `web-ui/src/components/shared/cline-setup-section.tsx`
  - `web-ui/src/components/task-start-agent-onboarding-carousel.tsx`
  - `scripts/upload-sentry-sourcemaps.mjs`
- Remove package dependencies:
  - root: `@clinebot/agents`, `@clinebot/core`, `@clinebot/llms`, `@sentry/node`, `@sentry/cli`
  - web: `@clinebot/shared`, `@sentry/react`, `@posthog/react`, `posthog-js`

#### Patch breakpoints after deletion

- Replace telemetry calls in:
  - `src/cli.ts`
  - `web-ui/src/main.tsx`
  - `web-ui/src/components/app-error-boundary.tsx`
  - `web-ui/src/hooks/use-linked-backlog-task-actions.ts`
  - `web-ui/src/hooks/use-task-editor.ts`
  - `web-ui/src/hooks/use-task-sessions.ts`
  - `web-ui/src/components/project-navigation-panel.tsx`
- Remove or replace Cline-specific imports in:
  - `src/trpc/runtime-api.ts`
  - `src/server/runtime-server.ts`
  - `src/server/runtime-state-hub.ts`
  - `src/core/api-contract.ts`
  - `src/config/runtime-config.ts`
  - `src/terminal/agent-session-adapters.ts`
  - `web-ui/src/runtime/native-agent.ts`
  - `web-ui/src/hooks/use-home-agent-session.ts`
  - `web-ui/src/hooks/use-cline-chat-*`
  - related tests

#### Rebrand

- Rename the product to `fs-kanban`.
- Move config home from `.cline/kanban` to `.fs-kanban`.
- Rename CLI binary from `kanban` to `fs-kanban`.
- Update visible product strings, titles, and docs.

#### Verification

- `rg -n "cline\\.bot|clinebot|sentry|posthog|featurebase|data\\.cline" .`
  - expected: zero runtime/product hits after cleanup
- `npm install`
- `npm run check`
- `npm run build`

### Phase 1: Runtime Foundation Port

#### Port Agent Runtime concepts into TypeScript

- Add `src/agents/`:
  - `engine-adapter.ts`
  - `codex-adapter.ts`
  - `claude-adapter.ts`
  - `engine-router.ts`
  - `run-status.ts`
  - later: `queue-store.ts`, `worktree-lifecycle.ts`

#### Integration strategy

- Keep `TerminalSessionManager` as the active process and terminal transport layer.
- Introduce richer run status as the canonical run lifecycle model.
- Project those statuses back into the existing four board columns for UI continuity.
- Put provider routing behind `runtime.startTaskSession`.
- Preserve turn checkpoint capture and terminal history flow.

#### Initial runtime target

- Supported agents:
  - `codex`
  - `claude`
- Per-card execution settings:
  - selected agent
  - autonomous mode toggle
  - plan mode toggle

### Phase 2: Durable State

- Introduce `queue.db` under `~/.config/fs-kanban/` only after Phase 1 is stable.
- Do not replace `sessions.json` in one step.
- First version should mirror durable run state while session summaries continue to feed the current UI contract.
- Add a migration path only once the queue-backed summaries are verified.

### Phase 3: Integrations

#### Git hydration

- First integration to land after runtime stabilization.
- Hydrate:
  - `git worktree list --porcelain`
  - `gh pr list`
- Project recent worktrees and open PRs into cards.

#### Notion

- Add sync from the validated ideas database.
- Use stable `externalId` mapping and additive sync semantics.

#### Todoist

- Add REST-backed task import using tokenized local config.
- Reuse the same sync engine and dedupe model as Notion.

### Phase 4: Worktree Cleanup

- Port lease marker and stale detection ideas from Agent Runtime.
- Do not auto-delete on shutdown.
- Any cleanup remains opt-in and confirmed.
- Avoid overlapping cleanup logic with current trash/shutdown paths.

### Current Risks

- Cline-specific runtime and UI surfaces are broader than the original note suggested.
- `home-agent` and native Cline chat flows will need removal or a clean alternative.
- Build/test cleanup will need coordinated changes across source, runtime contracts, and tests.
- Queue-backed persistence should be phased carefully to avoid drift against `sessions.json`.

### Execution Order

1. Finish Phase 0 sanitization and get a clean build.
2. Wire `codex` and `claude` through the new runtime seams.
3. Expand runtime state and persistence.
4. Add git hydration.
5. Add Notion and Todoist sync.
6. Add cleanup policy and polish.
