# FS Kanban Feature Completion Implementation Plan (Rev 6)

> **For agentic workers:** REQUIRED — Use `superpowers:subagent-driven-development` (if subagents available) or `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax. Do NOT run `git commit`; checkpoint reviews are manual.

**Goal:** Take three half-shipped features over the finish line: (1) the session-state-machine root-cause fix that's blocking the backlog cleanup button, (2) durable chat history that survives runtime restarts, and (3) a real Claude-auto-mode-style supervisor approval loop with visible queue and audit trail.

**Architecture:**
- **State machine fix (Phase 1):** Add an `agent.needs-input` event to `SessionTransitionEvent`. Codex and Claude prompt detectors emit it when output shows a prompt while the session is `running`. The existing `normalizeStaleSessionSummary` ([session-manager.ts:151](../../src/terminal/session-manager.ts:151)) already demotes any active state to `interrupted` on hydrate — we keep that behavior unchanged and only verify with tests. Test transitions through `prepareAgentLaunch().detectOutputTransition`, the actual public API.
- **Cleanup-button polish (Phase 2):** The Sparkles button exists at [web-ui/src/components/board-column.tsx:110](../../web-ui/src/components/board-column.tsx:110). Add a labeled variant + a "Restart board agent" sibling icon button to give the user a way out of stuck states.
- **Chat history (Phase 3):** Persist each pty session's output as a JSONL journal at `<getRuntimeHomePath()>/journals/<workspaceId>/<encoded-task-id>.jsonl` — **namespaced by workspace** so the same `taskId` in two workspaces does not collide. The journal is the single source of truth for cross-restart history; workspace-registry already feeds `replayHistoryByTaskId` into `manager.hydrateFromRecord` ([workspace-registry.ts:307](../../src/server/workspace-registry.ts:307)) — we hook the journal into both the read (hydrate) and write (pty chunk) paths. Whichever of journal-replay vs. legacy `session-replay.json` returns data first wins (journal preferred); no concat, no dedup.
- **Supervisor loop (Phase 4, split 4a/4b):** Promote the existing silent `maybeAutoApprovePendingPrompt` ([session-manager.ts:805](../../src/terminal/session-manager.ts:805)) into a queue. **Ownership: a process-singleton `SupervisorApprovalQueue` is constructed in `cli.ts` BEFORE `createWorkspaceRegistry` (see Task 4a.5 for exact boot order) and threaded into `createWorkspaceRegistry` (which constructs `TerminalSessionManager`s), `createRuntimeStateHub`, and `createRuntimeServer`.** Persist enqueue + decide events to `<getAuditHomePath()>/approvals.jsonl` with rotation. Broadcast queue events through the existing `runtime-state-hub` WebSocket (NOT tRPC subscriptions — they aren't wired). All WS message variants use the existing `type:` discriminator (NOT `kind:`), snake_case (e.g. `approval_request_queued`) — including in frontend reducers. New tRPC procedures go in `src/trpc/runtime-api.ts` AND must be registered in `src/trpc/app-router.ts`. Phase 4a ships backend; 4b ships UI.

**Tech Stack:** TypeScript (strict), vitest, React 19 + Tailwind v4 + Radix UI, node-pty, tRPC `httpBatchLink`, existing runtime-state WebSocket hub.

**Conventions** (from [AGENTS.md](../../AGENTS.md) and codex review):
- No `any`. No inline imports. Use shared types from `src/core/api-contract.ts`.
- Files 200–400 lines typical, 800 max.
- Tests under `test/runtime/...` for server, colocated `*.test.tsx` for web-ui.
- Run `npm run check` before each checkpoint (lint + typecheck + vitest).
- DO NOT `git commit` — the user reviews work and commits themselves.
- Replace plan refs to a "checkpoint" with: `npm run check` passing + brief written summary of what changed.

**File budget (revised):** ~40 files touched, ~30 new files.

**Status of Phase 0:** ✅ DONE. This worktree was rebased onto `origin/main` (`42851ab`). All previously-missing files (`src/terminal/agent-approval-policy.ts`, the Sparkles button, `evaluateSupervisedApproval`, etc.) now exist here.

---

## Chunk 1: Phase 1 — Session State Machine Root Cause Fix

The bug (verified): `codexPromptDetector` at [src/terminal/agent-session-adapters.ts:271](../../src/terminal/agent-session-adapters.ts:271) only fires when `summary.state === "awaiting_review"`. When Codex returns to its `›` prompt while state is still `running`, no transition fires, and downstream features (Sparkles button) refuse to act because [App.tsx:735](../../web-ui/src/App.tsx:735) reads "running" via `getRuntimeTaskSessionStatus`. Same issue applies to Claude — it has no prompt detector at all (`claudeAdapter.prepare` never sets `detectOutputTransition`).

**Approach:** introduce `agent.needs-input` event, give both adapters detectors that emit it, make the reducer idempotent so duplicate prompt frames don't churn state.

### Task 1.1: Extend `SessionTransitionEvent` with `agent.needs-input`

**Files:**
- Modify: [src/terminal/session-state-machine.ts](../../src/terminal/session-state-machine.ts)
- Test: [test/runtime/terminal/session-state-machine.test.ts](../../test/runtime/terminal/session-state-machine.test.ts) (NEW)

- [ ] **Step 1.1.1: Create the test file with TDD scaffolding**

Create `test/runtime/terminal/session-state-machine.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract.js";
import { reduceSessionTransition } from "../../../src/terminal/session-state-machine.js";

function summary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
  return {
    taskId: "task-1",
    state: "running",
    mode: null,
    agentId: "codex",
    workspacePath: "/tmp/wt",
    pid: 1234,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    lastOutputAt: Date.now(),
    reviewReason: null,
    exitCode: null,
    lastHookAt: null,
    latestHookActivity: null,
    warningMessage: null,
    latestTurnCheckpoint: null,
    previousTurnCheckpoint: null,
    ...overrides,
  };
}

describe("reduceSessionTransition — agent.needs-input", () => {
  it("transitions running → awaiting_review with reason 'attention' on first prompt", () => {
    const result = reduceSessionTransition(summary(), { type: "agent.needs-input" });
    expect(result.changed).toBe(true);
    expect(result.patch.state).toBe("awaiting_review");
    expect(result.patch.reviewReason).toBe("attention");
    expect(result.patch.latestHookActivity?.activityText).toBe("Waiting for input");
    expect(result.patch.latestHookActivity?.notificationType).toBe("user_attention");
    expect(result.patch.latestHookActivity?.source).toBe("codex");
  });

  it("is a no-op when already awaiting_review", () => {
    const result = reduceSessionTransition(
      summary({ state: "awaiting_review", reviewReason: "attention" }),
      { type: "agent.needs-input" },
    );
    expect(result.changed).toBe(false);
  });

  it("is idempotent when running summary already carries the Waiting-for-input marker", () => {
    // This is the real duplicate condition: detector still fires while state hasn't been broadcast yet.
    const result = reduceSessionTransition(
      summary({
        state: "running",
        latestHookActivity: {
          activityText: "Waiting for input",
          toolName: null,
          toolInputSummary: null,
          finalMessage: null,
          hookEventName: "agent.prompt-ready",
          notificationType: "user_attention",
          source: "codex",
        },
      }),
      { type: "agent.needs-input" },
    );
    expect(result.changed).toBe(false);
  });
});
```

- [ ] **Step 1.1.2: Run, expect failure**

```
npx vitest run test/runtime/terminal/session-state-machine.test.ts
```
Expected: failure — `agent.needs-input` is not a valid event variant; first test fails on `expect(result.changed).toBe(true)`.

- [ ] **Step 1.1.3: Add the event variant + reducer case**

In [src/terminal/session-state-machine.ts](../../src/terminal/session-state-machine.ts):

```ts
export type SessionTransitionEvent =
  | { type: "hook.to_review" }
  | { type: "hook.to_in_progress" }
  | { type: "agent.needs-input" }
  | { type: "agent.prompt-ready" }
  | { type: "process.exit"; exitCode: number | null; interrupted: boolean };
```

Add the case inside `reduceSessionTransition` (between `hook.to_in_progress`/`agent.prompt-ready` block and `process.exit`):

```ts
case "agent.needs-input": {
  if (summary.state !== "running") {
    return { changed: false, patch: {}, clearAttentionBuffer: false };
  }
  // Idempotency: don't churn state if marker already set.
  const existing = summary.latestHookActivity;
  if (
    existing?.activityText === "Waiting for input" &&
    existing?.notificationType === "user_attention"
  ) {
    return { changed: false, patch: {}, clearAttentionBuffer: false };
  }
  return {
    changed: true,
    patch: {
      state: "awaiting_review",
      reviewReason: "attention",
      latestHookActivity: {
        activityText: "Waiting for input",
        toolName: null,
        toolInputSummary: null,
        finalMessage: null,
        hookEventName: "agent.prompt-ready",
        notificationType: "user_attention",
        source: summary.agentId,
      },
    },
    clearAttentionBuffer: false,
  };
}
```

- [ ] **Step 1.1.4: Run, expect green**

```
npx vitest run test/runtime/terminal/session-state-machine.test.ts
```
All three tests pass.

- [ ] **Step 1.1.5: Checkpoint**

```
npm run check
```
Lint + typecheck + full test suite green. Brief written status: "Phase 1 Task 1 done — agent.needs-input event added with idempotent reducer behavior."

### Task 1.2: Codex prompt detector emits `agent.needs-input` when running

**Files:**
- Modify: [src/terminal/agent-session-adapters.ts](../../src/terminal/agent-session-adapters.ts) — `codexPromptDetector` at line 271
- Test: [test/runtime/terminal/agent-session-adapters.test.ts](../../test/runtime/terminal/agent-session-adapters.test.ts) (extend, do not replace)

- [ ] **Step 1.2.1: Read the existing public test seam**

Run: `grep -n "codexPromptDetector\|prepareAgentLaunch\|detectOutputTransition" src/terminal/agent-session-adapters.ts test/runtime/terminal/agent-session-adapters.test.ts`

Expected: `codexPromptDetector` is a private (file-scoped) `function`, NOT exported. Existing test calls `prepareAgentLaunch` and exercises `detectOutputTransition` from the returned `PreparedAgentLaunch`.

- [ ] **Step 1.2.2: Inspect the existing test file for shared helpers**

Run: `head -60 test/runtime/terminal/agent-session-adapters.test.ts` to identify what fixture helpers (if any) already exist. Two cases:

**(a) Helpers exist:** reuse them in the new tests.

**(b) Helpers don't exist:** the FIRST step is to add minimal test fixtures at the top of the test file. Merge with the file's existing imports — do NOT introduce duplicate imports of `describe/expect/it` or `prepareAgentLaunch`. Add `type AgentAdapterLaunchInput` (needed for the launch helper) and `type RuntimeTaskSessionSummary` (needed by the summary helper):

```ts
// At the top of test/runtime/terminal/agent-session-adapters.test.ts, alongside existing imports:
import { prepareAgentLaunch, type AgentAdapterLaunchInput } from "../../../src/terminal/agent-session-adapters.js";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract.js";

// Below the existing imports, before any describe blocks:
const baseLaunch: AgentAdapterLaunchInput = {
  taskId: "task-1",
  agentId: "codex",
  binary: "/usr/bin/false", // we never actually exec
  args: [],
  cwd: "/tmp",
  prompt: "",
};

function makeLaunchInput(overrides: Partial<AgentAdapterLaunchInput> = {}): AgentAdapterLaunchInput {
  return { ...baseLaunch, ...overrides };
}

function makeSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
  return {
    taskId: "task-1",
    state: "running",
    mode: null,
    agentId: "codex",
    workspacePath: "/tmp",
    pid: 1,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    lastOutputAt: Date.now(),
    reviewReason: null,
    exitCode: null,
    lastHookAt: null,
    latestHookActivity: null,
    warningMessage: null,
    latestTurnCheckpoint: null,
    previousTurnCheckpoint: null,
    ...overrides,
  };
}
```

(Verify the `AgentAdapterLaunchInput` shape against the actual export at `src/terminal/agent-session-adapters.ts`. `RuntimeAgentId` is NOT needed if `agentId: "codex"` is used as a literal. If `prepareAgentLaunch` has side effects like creating a temp settings dir, ensure tests clean it up via `afterEach`.)

- [ ] **Step 1.2.3: Add failing tests using the helpers**

```ts
it("codex detector emits agent.needs-input when prompt returns while running", async () => {
  const launch = await prepareAgentLaunch(makeLaunchInput({ agentId: "codex" }));
  const detect = launch.detectOutputTransition;
  expect(detect).toBeDefined();
  const ev = detect!("\n› ", makeSummary({ agentId: "codex", state: "running" }));
  expect(ev).toEqual({ type: "agent.needs-input" });
});

it("codex detector still emits agent.prompt-ready when returning from awaiting_review/attention", async () => {
  const launch = await prepareAgentLaunch(makeLaunchInput({ agentId: "codex" }));
  const ev = launch.detectOutputTransition!(
    "\n› ",
    makeSummary({ agentId: "codex", state: "awaiting_review", reviewReason: "attention" }),
  );
  expect(ev).toEqual({ type: "agent.prompt-ready" });
});
```

- [ ] **Step 1.2.4: Run, expect failure** (`agent.needs-input` never returned).

- [ ] **Step 1.2.5: Update `codexPromptDetector` and `shouldInspectCodexOutputForTransition`**

Replace the body of `codexPromptDetector` to:
```ts
function codexPromptDetector(data: string, summary: RuntimeTaskSessionSummary): SessionTransitionEvent | null {
  const stripped = stripAnsi(data);
  if (!/(?:^|\n)\s*›/.test(stripped)) return null;
  if (summary.state === "running") {
    return { type: "agent.needs-input" };
  }
  if (
    summary.state === "awaiting_review" &&
    (summary.reviewReason === "attention" || summary.reviewReason === "hook")
  ) {
    return { type: "agent.prompt-ready" };
  }
  return null;
}
```

Update `shouldInspectCodexOutputForTransition` to also return `true` when `summary.state === "running"` (so the framework actually invokes the detector while running).

- [ ] **Step 1.2.6: Run, expect green.**

- [ ] **Step 1.2.7: Checkpoint** (`npm run check`).

### Task 1.3: Claude prompt detector parity

**Files:**
- Modify: [src/terminal/agent-session-adapters.ts](../../src/terminal/agent-session-adapters.ts) — `claudeAdapter.prepare` at line 166
- Test: [test/runtime/terminal/agent-session-adapters.test.ts](../../test/runtime/terminal/agent-session-adapters.test.ts)

- [ ] **Step 1.3.1: Failing test for Claude detection (signature: `(data: string, summary)`)**

```ts
it("claude detector emits agent.needs-input when prompt returns while running", async () => {
  const launch = await prepareAgentLaunch(makeLaunchInput({ agentId: "claude" }));
  expect(launch.detectOutputTransition).toBeDefined();
  // Real Claude prompt: a box border with > cursor inside
  const data = "\n╭──╮\n│ > │\n╰──╯\n";
  const ev = launch.detectOutputTransition!(data, makeSummary({ agentId: "claude", state: "running" }));
  expect(ev).toEqual({ type: "agent.needs-input" });
});

it("claude detector emits agent.prompt-ready when returning from awaiting_review/attention", async () => {
  const launch = await prepareAgentLaunch(makeLaunchInput({ agentId: "claude" }));
  const ev = launch.detectOutputTransition!(
    "\n╭──╮\n│ > │\n╰──╯\n",
    makeSummary({ agentId: "claude", state: "awaiting_review", reviewReason: "attention" }),
  );
  expect(ev).toEqual({ type: "agent.prompt-ready" });
});
```

- [ ] **Step 1.3.2: Run, expect failure.**

- [ ] **Step 1.3.3: Implement `claudePromptDetector` and wire it.**

Add a `claudePromptDetector` similar in shape to `codexPromptDetector`, using regex `/[╭│╰][^\n]*?>\s/` against `stripAnsi(data)`. In `claudeAdapter.prepare`, set `detectOutputTransition: claudePromptDetector` on the returned `PreparedAgentLaunch`. Mirror `shouldInspectCodexOutputForTransition` for Claude (or unify both into a common helper).

- [ ] **Step 1.3.4: Run, expect green. Checkpoint** (`npm run check`).

### Task 1.4: Verify existing stuck-`running` reconciliation has test coverage

**Note:** the existing `normalizeStaleSessionSummary` ([session-manager.ts:151](../../src/terminal/session-manager.ts:151)) already demotes any state where `isActiveState(state) === true` (i.e., `running` or `awaiting_review`) to `state: "interrupted", reviewReason: "interrupted", pid: null`. This is the correct behavior — the UI handles `interrupted` differently from `awaiting_review`, and demoting to `awaiting_review/interrupted` would falsely surface a "ready for review" treatment. Phase 1.4's purpose is reduced to *verifying* the existing behavior with tests so a future regression is caught. **No source changes here.**

**Files:**
- Test: [test/runtime/terminal/session-manager.test.ts](../../test/runtime/terminal/session-manager.test.ts) (extend)

- [ ] **Step 1.4.1: Verify the existing reconciler covers `running`**

Run: `grep -n "isActiveState\|normalizeStaleSessionSummary" src/terminal/session-manager.ts | head -10`
Expected: `isActiveState` returns true for `"running"` and `"awaiting_review"`. `normalizeStaleSessionSummary` is invoked from `hydrateFromRecord` (line 261) and `restartActiveSession` (line 719).

- [ ] **Step 1.4.2: Add a failing test asserting the behavior**

```ts
// test/runtime/terminal/session-manager.test.ts
it("hydrateFromRecord demotes a running summary to interrupted (no PTY exists post-restart)", () => {
  const mgr = createManagerForTest(); // use the existing test factory
  mgr.hydrateFromRecord({
    "t-zombie": makeSummary({ taskId: "t-zombie", state: "running", pid: 999999 }),
  });
  const after = mgr.getSummary("t-zombie");
  expect(after?.state).toBe("interrupted");
  expect(after?.reviewReason).toBe("interrupted");
  expect(after?.pid).toBeNull();
});

it("hydrateFromRecord also demotes awaiting_review to interrupted (active state without process)", () => {
  const mgr = createManagerForTest();
  mgr.hydrateFromRecord({
    "t-await": makeSummary({ taskId: "t-await", state: "awaiting_review", reviewReason: "attention", pid: 1 }),
  });
  expect(mgr.getSummary("t-await")?.state).toBe("interrupted");
});

it("hydrateFromRecord leaves non-active states untouched", () => {
  const mgr = createManagerForTest();
  mgr.hydrateFromRecord({
    "t-ok": makeSummary({ taskId: "t-ok", state: "interrupted", reviewReason: "exit", pid: null }),
  });
  expect(mgr.getSummary("t-ok")?.state).toBe("interrupted");
  expect(mgr.getSummary("t-ok")?.reviewReason).toBe("exit");
});
```

(Reuse `createManagerForTest`/`makeSummary` patterns from existing session-manager tests — copy from neighboring test cases.)

- [ ] **Step 1.4.3: Run; if any of these assertions are surprises, the existing behavior diverged — investigate before moving on.**

- [ ] **Step 1.4.4: Checkpoint.**

### Task 1.5: Manual verification (deferred — needs runtime restart)

- [ ] **Step 1.5.1: Build and document smoke steps for the user.**

```
npm run build
```
Then write a one-paragraph smoke checklist into the plan's Done Definition listing exact UI steps to verify. Do NOT restart the user's running runtime.

---

## Chunk 2: Phase 2 — Cleanup Button Robustness & UX

The Sparkles cleanup button already exists ([board-column.tsx:110](../../web-ui/src/components/board-column.tsx:110)). With Phase 1's state-machine fix, the false-positive "agent already running" toast goes away in the common case. Phase 2 adds a labeled variant + a "Restart board agent" sibling so the user always has a manual escape if state ever wedges. We **drop** the original Phase 2.3 (ephemeral-runner fallback) — codex finding #23 was right that `src/runtime/` doesn't fit, and the value isn't worth the cost.

Codex finding #8: `web-ui/src/components/board-column.test.tsx` doesn't exist. Test through `kanban-board.test.tsx` instead.

### Task 2.1: Restart-board-agent button

**Files:**
- Modify: [web-ui/src/components/board-column.tsx](../../web-ui/src/components/board-column.tsx)
- Modify: [web-ui/src/components/kanban-board.tsx](../../web-ui/src/components/kanban-board.tsx) (forward prop)
- Modify: [web-ui/src/components/detail-panels/column-context-panel.tsx](../../web-ui/src/components/detail-panels/column-context-panel.tsx) (mirror for the panel duplicate)
- Modify: [web-ui/src/App.tsx](../../web-ui/src/App.tsx) — add `handleRestartBoardAgent`
- Test: [web-ui/src/components/kanban-board.test.tsx](../../web-ui/src/components/kanban-board.test.tsx) (extend) and [web-ui/src/components/detail-panels/column-context-panel.test.tsx](../../web-ui/src/components/detail-panels/column-context-panel.test.tsx)

- [ ] **Step 2.1.1: Locate the existing home-agent restart entrypoint.**

Run: `grep -rn "restart\|stopSession\|killSession\|terminateSession" src/trpc/ src/terminal/ | grep -i "home\|sidebar" | head`
If nothing matches, the right path is `runtime.task.stop` + `runtime.task.start` — search for those.

- [ ] **Step 2.1.2: Add failing test for the new prop and button rendering.**

In `kanban-board.test.tsx`, render with `column.id === "backlog"` and `onRestartBoardAgent` prop set. Assert button with `aria-label="Restart board agent"` is present, calls the prop on click.

- [ ] **Step 2.1.3: Wire the prop chain.**

Add `onRestartBoardAgent?: () => void` to `KanbanBoard`, `BoardColumn`, and `ColumnContextPanel` props. Render a `<RotateCcw size={14}>` icon button on the **Backlog** column header next to the Sparkles button. Use `Tooltip` with content "Restart board agent (use if it gets stuck)". Show only when `column.id === "backlog"` and prop is provided.

- [ ] **Step 2.1.4: Implement `handleRestartBoardAgent` in App.tsx.**

It should: (a) call the runtime stop/restart for `homeSidebarAgentTaskId`, (b) show a toast `"Restarting board agent…"`, (c) if the restart endpoint errors, surface via `notifyError`.

- [ ] **Step 2.1.5: Run, expect green. Checkpoint.**

### Task 2.2: Label the cleanup button

**Files:**
- Modify: [web-ui/src/components/board-column.tsx](../../web-ui/src/components/board-column.tsx) — line 111-127

- [ ] **Step 2.2.1: Update the button to show "Clean up" alongside the icon.**

```tsx
<Button
  icon={<Sparkles size={14} />}
  variant="ghost"
  size="sm"
  onClick={onRunBacklogCleanup}
  disabled={column.cards.length === 0}
  aria-label="Clean up backlog with board agent"
  title={column.cards.length > 0 ? "Review and clean up backlog with the board agent" : "Backlog is empty"}
>
  Clean up
</Button>
```

If column header overflows after adding the label (column ≈280px wide, already has Play + Trash buttons), gate the visible label on a media query OR move text-only buttons into a `<DropdownMenu>` overflow. Validate visually before claiming done.

- [ ] **Step 2.2.2: Snapshot/test updates if any.**

- [ ] **Step 2.2.3: Run, checkpoint.**

---

## Chunk 3: Phase 3 — Durable Chat History Across Reloads

Today the in-memory ring at [pty-session.ts:107](../../src/terminal/pty-session.ts:107) (`outputHistory`, capped at `MAX_HISTORY_BYTES`) survives **page reloads** via the existing replay path ([session-manager.ts:303](../../src/terminal/session-manager.ts:303)) but is wiped on **runtime restart**. `hydrateFromRecord` already takes a `replayHistoryByTaskId` arg ([session-manager.ts:255](../../src/terminal/session-manager.ts:255)) — we just need to populate that arg from disk.

### Task 3.0: Prerequisite — add subdir helpers next to existing `getRuntimeHomePath`

There are TWO `getRuntimeHomePath` declarations: a private one in [src/config/runtime-config.ts:127](../../src/config/runtime-config.ts:127) (used only inside that file) and an EXPORTED one in [src/state/workspace-state.ts:187](../../src/state/workspace-state.ts:187) (already used across runtime/terminal code). We use the existing exported one and add sibling helpers there. **Do NOT duplicate the helper.** Do NOT export the runtime-config one — leave that file alone.

**Files:**
- Modify: [src/state/workspace-state.ts](../../src/state/workspace-state.ts) — add new exports next to `getRuntimeHomePath`/`getTaskWorktreesHomePath`

- [ ] **Step 3.0.1: Add helpers**

```ts
const JOURNALS_DIR = "journals";
const AUDIT_DIR = "audit";

export function getJournalsHomePath(): string {
  return join(getRuntimeHomePath(), JOURNALS_DIR);
}

export function getWorkspaceJournalDir(workspaceId: string): string {
  return join(getJournalsHomePath(), workspaceId);
}

export function getAuditHomePath(): string {
  return join(getRuntimeHomePath(), AUDIT_DIR);
}
```

- [ ] **Step 3.0.2: `npm run check` to verify nothing breaks.**

- [ ] **Step 3.0.3: Checkpoint.**

### Task 3.1: `OutputJournal` module with internal write queue

**Files:**
- Create: `src/terminal/output-journal.ts`
- Test: `test/runtime/terminal/output-journal.test.ts`

Codex finding #11 (HIGH): naive fire-and-forget `await journal.append()` from PTY hot path can reorder + race rotation. Solution: internal serialization queue.
Codex finding #12 (MEDIUM): raw taskId for filename is unsafe (e.g. `__home_agent__:ws:codex` contains `:` which is invalid on Windows). Solution: encode + store taskId inside JSON record.

- [ ] **Step 3.1.1: Failing tests**

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { OutputJournal } from "../../../src/terminal/output-journal.js";

describe("OutputJournal", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "fs-journal-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("encodes path-hostile task IDs into a safe filename basename", () => {
    const j = new OutputJournal({ dir, taskId: "__home_agent__:ws:codex" });
    const filename = basename(j.filePath());
    // basename must NOT contain colons (Windows-hostile)
    expect(filename).not.toMatch(/[:]/);
    expect(filename.endsWith(".jsonl")).toBe(true);
  });

  it("exposes a stable encodeSlug for filename generation", () => {
    const slug1 = OutputJournal.encodeSlug("__home_agent__:ws:codex");
    const slug2 = OutputJournal.encodeSlug("__home_agent__:ws:codex");
    expect(slug1).toBe(slug2);
    expect(slug1).not.toMatch(/[:]/);
  });

  it("serializes appends; reads back in order even when fired without await", async () => {
    const j = new OutputJournal({ dir, taskId: "t1" });
    j.append(Buffer.from("a"));
    j.append(Buffer.from("b"));
    j.append(Buffer.from("c"));
    await j.close();
    const lines = readFileSync(j.filePath(), "utf8").trim().split("\n");
    expect(lines.map((l) => JSON.parse(l).b64)).toEqual(["a", "b", "c"].map((s) => Buffer.from(s).toString("base64")));
  });

  it("includes taskId in every record so on-disk file is self-describing", async () => {
    const j = new OutputJournal({ dir, taskId: "__home_agent__:ws:codex" });
    j.append(Buffer.from("x"));
    await j.close();
    const lines = readFileSync(j.filePath(), "utf8").trim().split("\n");
    expect(JSON.parse(lines[0]).taskId).toBe("__home_agent__:ws:codex");
  });

  it("rotates when file exceeds maxBytes; replay returns full ordered transcript", async () => {
    const j = new OutputJournal({ dir, taskId: "t-rot", maxBytes: 64 });
    for (let i = 0; i < 20; i++) j.append(Buffer.from("0123456789"));
    await j.close();
    const replay = await OutputJournal.replay({ dir, taskId: "t-rot" });
    expect(Buffer.concat(replay).toString()).toBe("0123456789".repeat(20));
  });

  it("preserves rotation counter across restarts so we don't overwrite", async () => {
    // (`readdir` is imported at the top of this test file from "node:fs/promises". No inline imports.)
    // First lifecycle: write enough to rotate once.
    const j1 = new OutputJournal({ dir, taskId: "t-restart", maxBytes: 32 });
    for (let i = 0; i < 5; i++) j1.append(Buffer.from("xxxxxxxxxxxx"));
    await j1.close();
    const after1 = await readdir(dir);
    expect(after1.some((f) => f.match(/\.1\.jsonl$/))).toBe(true);

    // Second lifecycle: same taskId.
    const j2 = new OutputJournal({ dir, taskId: "t-restart", maxBytes: 32 });
    for (let i = 0; i < 5; i++) j2.append(Buffer.from("yyyyyyyyyyyy"));
    await j2.close();
    const after2 = await readdir(dir);
    expect(after2.some((f) => f.match(/\.2\.jsonl$/))).toBe(true);

    // And replay returns ALL data ordered correctly.
    const replay = await OutputJournal.replay({ dir, taskId: "t-restart" });
    const text = Buffer.concat(replay).toString();
    expect(text.startsWith("xxxxxxxxxxxx")).toBe(true);
    expect(text.endsWith("yyyyyyyyyyyy")).toBe(true);
  });

  it("isolates same taskId across different workspace dirs", async () => {
    const wsA = join(dir, "ws-a");
    const wsB = join(dir, "ws-b");
    const ja = new OutputJournal({ dir: wsA, taskId: "task-1" });
    const jb = new OutputJournal({ dir: wsB, taskId: "task-1" });
    ja.append(Buffer.from("from-a"));
    jb.append(Buffer.from("from-b"));
    await ja.close();
    await jb.close();
    const replayA = Buffer.concat(await OutputJournal.replay({ dir: wsA, taskId: "task-1" })).toString();
    const replayB = Buffer.concat(await OutputJournal.replay({ dir: wsB, taskId: "task-1" })).toString();
    expect(replayA).toBe("from-a");
    expect(replayB).toBe("from-b");
  });

  it("close() awaits all in-flight appends", async () => {
    const j = new OutputJournal({ dir, taskId: "t-close" });
    j.append(Buffer.from("a"));
    j.append(Buffer.from("b"));
    await j.close();
    const replay = await OutputJournal.replay({ dir, taskId: "t-close" });
    expect(Buffer.concat(replay).toString()).toBe("ab");
  });
});
```

- [ ] **Step 3.1.2: Run, expect import failure.**

- [ ] **Step 3.1.3: Implement `OutputJournal`**

Sketch:
```ts
import { createWriteStream, type WriteStream } from "node:fs";
import { rename, readdir, readFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

interface JournalOptions {
  dir: string;            // workspace-scoped: <runtimeHome>/journals/<workspaceId>
  taskId: string;
  maxBytes?: number;       // default 8 MB
}

interface JournalRecord {
  seq: number;
  ts: number;
  taskId: string;
  b64: string;
}

export class OutputJournal {
  private writeChain: Promise<void> = Promise.resolve();
  private seq = 0;
  private bytesInFile = 0;
  private stream: WriteStream | null = null;
  private fileSlug: string;
  private rotation = 0;

  constructor(private readonly opts: JournalOptions) {
    this.fileSlug = OutputJournal.encodeSlug(opts.taskId);
  }

  /** Initialize rotation counter from existing files so we don't overwrite after restart. */
  private async initRotationCounter(): Promise<void> {
    if (this.rotation > 0) return;
    try {
      const files = await readdir(this.opts.dir);
      const max = files
        .map((f) => f.startsWith(this.fileSlug) ? parseRotation(f) : 0)
        .filter((n) => Number.isFinite(n))
        .reduce((a, b) => Math.max(a, b), 0);
      this.rotation = max;
    } catch {
      // dir doesn't exist yet — that's fine; rotation stays 0
    }
  }

  static encodeSlug(taskId: string): string {
    // Replace any non-[A-Za-z0-9_-] with underscore, then append a short stable hash for collision safety
    const safe = taskId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
    const hash = createHash("sha1").update(taskId).digest("hex").slice(0, 8);
    return `${safe}-${hash}`;
  }

  filePath(): string {
    return join(this.opts.dir, `${this.fileSlug}.jsonl`);
  }

  append(chunk: Buffer): void {
    this.writeChain = this.writeChain.then(() => this.appendInternal(chunk));
    // intentionally not awaiting — caller should be PTY hot path
  }

  private async appendInternal(chunk: Buffer): Promise<void> {
    await mkdir(this.opts.dir, { recursive: true });
    await this.initRotationCounter();
    if (!this.stream) {
      this.stream = createWriteStream(this.filePath(), { flags: "a" });
    }
    this.seq += 1;
    const rec: JournalRecord = {
      seq: this.seq,
      ts: Date.now(),
      taskId: this.opts.taskId,
      b64: chunk.toString("base64"),
    };
    const line = `${JSON.stringify(rec)}\n`;
    this.bytesInFile += Buffer.byteLength(line);
    await new Promise<void>((resolve, reject) =>
      this.stream!.write(line, (err) => (err ? reject(err) : resolve())),
    );
    if (this.bytesInFile > (this.opts.maxBytes ?? 8 * 1024 * 1024)) {
      await this.rotate();
    }
  }

  private async rotate(): Promise<void> {
    if (!this.stream) return;
    await new Promise<void>((res) => this.stream!.end(res));
    this.rotation += 1;
    await rename(this.filePath(), join(this.opts.dir, `${this.fileSlug}.${this.rotation}.jsonl`));
    this.stream = null;
    this.bytesInFile = 0;
  }

  async close(): Promise<void> {
    await this.writeChain;
    if (this.stream) {
      await new Promise<void>((res) => this.stream!.end(res));
      this.stream = null;
    }
  }

  static async replay(opts: { dir: string; taskId: string }): Promise<readonly Buffer[]> {
    const slug = OutputJournal.encodeSlug(opts.taskId);
    let files: string[];
    try {
      files = (await readdir(opts.dir)).filter((f) => f.startsWith(slug));
    } catch {
      return [];
    }
    const ordered = files.sort((a, b) => {
      // base file last (no rotation suffix). Rotated files have .N.jsonl.
      const aN = parseRotation(a);
      const bN = parseRotation(b);
      return aN - bN;
    });
    const buffers: Buffer[] = [];
    for (const file of ordered) {
      const content = await readFile(join(opts.dir, file), "utf8");
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as JournalRecord;
          buffers.push(Buffer.from(rec.b64, "base64"));
        } catch {
          // skip corrupt line
        }
      }
    }
    return buffers;
  }
}

function parseRotation(filename: string): number {
  const m = filename.match(/\.(\d+)\.jsonl$/);
  if (m) return Number(m[1]);
  return Number.POSITIVE_INFINITY; // base file sorts last → most recent writes last
}
```

- [ ] **Step 3.1.4: Iterate until tests green. Checkpoint.**

### Task 3.2: Wire journal into PTY chunk path via an `outputSink`

To keep `PtySession` decoupled from journal type, we add an `outputSink?: (chunk: Buffer) => void` option to `PtySession.spawn` ([pty-session.ts:137](../../src/terminal/pty-session.ts:137)). The session-manager wires `journal.append.bind(journal)` as the sink. The journal owns its own write serialization; sinks are called fire-and-forget from the chunk-receive path.

**Files:**
- Modify: [src/terminal/pty-session.ts](../../src/terminal/pty-session.ts) — extend `SpawnPtySessionRequest` with `outputSink?` and call it in the chunk-receive path
- Test: extend `test/runtime/terminal/pty-session.test.ts` (or create if missing)

- [ ] **Step 3.2.1: Failing test — when `outputSink` is provided, every chunk pushed into `outputHistory` is also passed to the sink in order.**

Use a vitest spy: `const sink = vi.fn()`. Construct via `PtySession.spawn({ binary: "/bin/echo", args: ["hi"], cwd: ".", onData: () => {}, onExit: () => {}, outputSink: sink })`. Wait for the `hi` chunk. Assert `sink` was called at least once with a `Buffer` containing `hi`.

- [ ] **Step 3.2.2: Implement the option.**

In the chunk-receive code (the place around line 120 that currently does `this.outputHistory.push(chunk)`), call `this.outputSink?.(chunk)`. Don't await. Don't try/catch — sink errors should crash the test, not swallow.

`PtySession` has no `dispose()` method. Drain semantics live in the session-manager (which owns the journal), not in `PtySession`. When `onExit` fires for a session, the manager calls `journal.close()` on its tracked journal.

- [ ] **Step 3.2.3: Run, green. Checkpoint.**

### Task 3.3: Construct journal in session-manager when session starts; drain on hydrate

**Files:**
- Modify: [src/terminal/session-manager.ts](../../src/terminal/session-manager.ts) — wherever `new PtySession(…)` is called
- Modify: [src/server/workspace-registry.ts](../../src/server/workspace-registry.ts) — line 307, pass journal-replayed history into `replayHistoryByTaskId`
- Test: extend `test/runtime/terminal/session-manager.test.ts` and `test/runtime/server/workspace-registry.test.ts` if it exists

Approach:
- Each workspace has its OWN journals dir: `getWorkspaceJournalDir(workspaceId)` (added in Task 3.0).
- `TerminalSessionManager` is constructed per-workspace inside [createWorkspaceRegistry](../../src/server/workspace-registry.ts:251) at line 303 — extend the constructor to accept `workspaceJournalDir: string`. The registry passes `getWorkspaceJournalDir(workspaceId)` for each workspace.
- When `TerminalSessionManager` starts a PTY, it constructs `OutputJournal({ dir: this.workspaceJournalDir, taskId })`.
- When `workspace-registry` builds `replayHistoryByTaskId` for `manager.hydrateFromRecord`, it queries `OutputJournal.replay({ dir: getWorkspaceJournalDir(workspaceId), taskId })`. Prefer journal replay; fall back to the legacy `session-replay.json` ONLY when journal is empty for that taskId. **No concat, no merge** — single source of truth.

- [ ] **Step 3.3.1: Find the session-start site**

Run: `grep -n "new PtySession" src/terminal/session-manager.ts`

- [ ] **Step 3.3.2: Failing integration test — start a manager, write some output via fake pty, dispose, re-construct manager, hydrate, assert replay returns the prior output even with no active session.**

- [ ] **Step 3.3.3: Implement.**

In `TerminalSessionManager`:
- Add a constructor that accepts `{ workspaceJournalDir: string }` and stores it as `this.workspaceJournalDir`. (Currently `TerminalSessionManager` has no explicit constructor — adding one is fine, just update the test factories that instantiate it.)
- In the start path: `const journal = new OutputJournal({ dir: this.workspaceJournalDir, taskId })`.
- Track per-task journals in a `Map<string, OutputJournal>` so `onExit` can `await journal.close()` for the correct entry.
- Add an `outputSink?: (chunk: Buffer) => void` option to `PtySession.spawn` ([pty-session.ts:137](../../src/terminal/pty-session.ts:137)). The manager passes `journal.append.bind(journal)` as the sink.
- **PtySession has no `dispose()` method — drain via `onExit` callback in the manager.**

In `createWorkspaceRegistry` ([src/server/workspace-registry.ts:303](../../src/server/workspace-registry.ts:303)):
- When constructing `new TerminalSessionManager(...)`, pass `{ workspaceJournalDir: getWorkspaceJournalDir(workspaceId) }`.
- Before calling `manager.hydrateFromRecord(...)`, build `replayHistoryByTaskId` like:
  ```ts
  const dir = getWorkspaceJournalDir(workspaceId);
  for (const taskId of Object.keys(persistedSummaries)) {
    const fromJournal = await OutputJournal.replay({ dir, taskId });
    replayHistoryByTaskId[taskId] = fromJournal.length > 0
      ? fromJournal
      : (legacyReplayHistoryByTaskId[taskId] ?? []);
  }
  ```
- **Do not concat the two sources** — risks duplicating chunks.

- [ ] **Step 3.3.4: Run, green. Checkpoint.**

### Task 3.4: GC journals on permanent deletion ONLY

**Important:** trashing a task is reversible (existing UI restore-from-trash). The complication: `deleteWorktree` is called BOTH by `task trash` (reversible cleanup) AND by `task delete` / clear-trash (permanent removal). Journal GC must distinguish these.

**Solution:** add `preserveJournal: z.boolean().default(true)` to `runtimeWorktreeDeleteRequestSchema` ([src/core/api-contract.ts:643](../../src/core/api-contract.ts:643)) — the actual zod schema for the delete request. Thread the flag through `workspace-api.deleteWorktree` ([src/trpc/workspace-api.ts:328](../../src/trpc/workspace-api.ts:328)) into the journal GC step.

Permanent-delete entry points (set `preserveJournal: false`):
- `task delete --task-id ...` ([src/commands/task.ts](../../src/commands/task.ts))
- `task delete --column trash` (clear-trash)
- Project removal — `projects-api.ts` ([src/trpc/projects-api.ts:164](../../src/trpc/projects-api.ts:164))
- Workspace auto-prune (search for it: `grep -rn "auto.prune\|autoprune\|stale.*workspace" src/`)

Reversible-delete entry points (default `preserveJournal: true`):
- `task trash`
- UI aggregate-board trash actions ([web-ui/src/hooks/use-aggregate-board-actions.ts:163](../../web-ui/src/hooks/use-aggregate-board-actions.ts:163))

For project removal specifically: also remove the entire workspace journal directory `<getJournalsHomePath()>/<workspaceId>` since no task ID is needed.

**Files:**
- Modify: [src/core/api-contract.ts:643](../../src/core/api-contract.ts:643) — extend `runtimeWorktreeDeleteRequestSchema` with `preserveJournal`
- Modify: [src/trpc/workspace-api.ts:328](../../src/trpc/workspace-api.ts:328) — accept and act on the flag
- Modify: [src/commands/task.ts](../../src/commands/task.ts) — `task delete` callers pass `preserveJournal: false`
- Modify: [src/trpc/projects-api.ts](../../src/trpc/projects-api.ts) — project removal removes workspace journal dir
- Test: extend `test/runtime/trpc/workspace-api.test.ts` (or create)

- [ ] **Step 3.4.1: Failing tests:**
  - `deleteWorktree({ preserveJournal: true })` keeps the journal files.
  - `deleteWorktree({ preserveJournal: false })` removes `<workspaceJournalDir>/<slug>.jsonl` and any rotated `*.N.jsonl`.
  - Schema default is `true` (safety).

- [ ] **Step 3.4.2: Implement schema + workspace-api flag handling.**

When `preserveJournal === false`, after successful worktree removal, scan `<workspaceJournalDir>` for files matching `<slug>*` and unlink them.

- [ ] **Step 3.4.3: Update permanent-delete callers** in `task.ts`, `projects-api.ts`, and any auto-prune site to pass `preserveJournal: false`. For project removal, also `rm -rf <getWorkspaceJournalDir(workspaceId)>`.

- [ ] **Step 3.4.4: Run, green. Checkpoint.**

### Task 3.5: Cap memory cost of replay

After hydrate, the in-memory `replayOutputHistory` could be huge (journal could be many MB). Cap it at the same byte budget as `MAX_HISTORY_BYTES` (currently a private const at [pty-session.ts:3](../../src/terminal/pty-session.ts:3)).

**Files:**
- Modify: [src/terminal/pty-session.ts](../../src/terminal/pty-session.ts) — `export const MAX_HISTORY_BYTES = …` (or extract a shared `capReplayHistoryBytes(buffers): Buffer[]` helper)
- Modify: [src/terminal/session-manager.ts](../../src/terminal/session-manager.ts) — apply the cap in `hydrateFromRecord`
- Test: extend `test/runtime/terminal/session-manager.test.ts`

- [ ] **Step 3.5.1: Export `MAX_HISTORY_BYTES` (or the helper).**

- [ ] **Step 3.5.2: In `hydrateFromRecord`, after building each entry's `replayOutputHistory`, trim from the END so total bytes ≤ `MAX_HISTORY_BYTES`.**

- [ ] **Step 3.5.3: Failing test — hydrate with a fixture > MAX_HISTORY_BYTES; assert in-memory size after hydrate is ≤ cap and contains the latest chunks (most recent end of transcript).**

- [ ] **Step 3.5.4: Implement, green, checkpoint.**

---

## Chunk 4a: Phase 4a — Supervisor Approval Queue (Backend)

(Codex finding #24: split Phase 4. This is the backend-only half. Phase 4b adds the UI.)

The existing flow at [session-manager.ts:805](../../src/terminal/session-manager.ts:805) (`maybeAutoApprovePendingPrompt`) silently pushes `\r` to the PTY when the policy says it's safe. We promote this into a proper queue with audit trail and broadcast events, while keeping the auto-approve fast-path for `read_only_tool` and `safe_shell_command` decisions.

Codex finding #19: Claude `PermissionRequest` hook lacks `notificationType`. Codex finding #18: manual approve/deny needs an execution path. Codex finding #16: web client uses `httpBatchLink` only — use the existing runtime-state WebSocket hub for broadcasts.

### Task 4a.1: Enrich Claude `PermissionRequest` hook metadata

**Files:**
- Modify: [src/terminal/agent-session-adapters.ts:211](../../src/terminal/agent-session-adapters.ts:211)
- Test: extend [test/runtime/terminal/agent-session-adapters.test.ts](../../test/runtime/terminal/agent-session-adapters.test.ts)

- [ ] **Step 4a.1.1: Failing test through the public API — call `prepareAgentLaunch({ agentId: "claude", workspaceId, ... })`, then read the generated Claude settings.json (its path is in `launch.env`/`launch.cleanup`-tracked tempdir, OR in the prepared command's args). Assert that `PermissionRequest[0].hooks[0].command` contains `--notification-type permission_prompt`.**

(Look at how existing tests in `agent-session-adapters.test.ts` inspect the prepared launch — there's likely a helper to read the materialized settings file. Mirror it.)

- [ ] **Step 4a.1.2: Update the Claude PermissionRequest hook config to pass `notificationType: "permission_prompt"` via `buildHookCommand`'s metadata options.**

Currently:
```ts
PermissionRequest: [
  { matcher: "*", hooks: [{ type: "command", command: buildHookCommand("to_review", { source: "claude" }) }] },
],
```

After:
```ts
PermissionRequest: [
  {
    matcher: "*",
    hooks: [{
      type: "command",
      command: buildHookCommand("to_review", { source: "claude", notificationType: "permission_prompt" }),
    }],
  },
],
```

Verify `buildHookCommand` already accepts and forwards `notificationType` ([commands/hooks.ts:188](../../src/commands/hooks.ts:188)) — it does.

- [ ] **Step 4a.1.3: Run, green. Checkpoint.**

### Task 4a.2: Approval request schema + queue module

**Files:**
- Modify: [src/core/api-contract.ts](../../src/core/api-contract.ts)
- Create: `src/terminal/supervisor-approval-queue.ts`
- Test: `test/runtime/terminal/supervisor-approval-queue.test.ts`

- [ ] **Step 4a.2.1: Add schemas to api-contract**

```ts
export const runtimeApprovalDecisionSchema = z.enum([
  "pending", "auto_approved", "auto_denied", "user_approved", "user_denied", "timed_out",
]);
export type RuntimeApprovalDecision = z.infer<typeof runtimeApprovalDecisionSchema>;

export const runtimeApprovalRequestSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  workspaceId: z.string(),
  agentId: runtimeAgentIdSchema.nullable(),
  activity: runtimeTaskHookActivitySchema,
  fingerprint: z.string(),
  autoDecision: z.object({
    shouldAutoApprove: z.boolean(),
    reason: z.string(),
  }),
  status: runtimeApprovalDecisionSchema,
  createdAt: z.number(),
  decidedAt: z.number().nullable(),
  decidedBy: z.enum(["policy", "user"]).nullable(),
});
export type RuntimeApprovalRequest = z.infer<typeof runtimeApprovalRequestSchema>;
```

- [ ] **Step 4a.2.2: TDD the queue**

`SupervisorApprovalQueue` API:
- `enqueue(input): RuntimeApprovalRequest` — idempotency rule: dedupe **only against currently-pending requests** matching `(taskId, fingerprint)`. After a decide, the same fingerprint can re-enqueue (the agent might prompt again later). Returns the existing pending record if found, else creates a new one.
- `decide(id, decision, decidedBy): RuntimeApprovalRequest | null` — updates status. No-op if already non-pending (idempotent on id).
- `pending(): readonly RuntimeApprovalRequest[]`
- `byTask(taskId): readonly RuntimeApprovalRequest[]`
- `byWorkspace(workspaceId): readonly RuntimeApprovalRequest[]`
- `subscribe(listener: (event: SupervisorApprovalQueueEvent) => void): () => void`

```ts
export type SupervisorApprovalQueueEvent =
  | { type: "queued"; request: RuntimeApprovalRequest }
  | { type: "decided"; request: RuntimeApprovalRequest };
```

Listeners are called synchronously after the queue's internal mutation. Any listener throw is caught + logged; no listener can break others.

Tests must cover:
- Enqueue with same fingerprint while previous decision is pending returns same record (true idempotency).
- Enqueue with same fingerprint AFTER previous request was decided creates a new pending record (re-prompt scenario).
- Idempotent decide on an already-decided id is a no-op.
- Listener notification on enqueue + decide.
- byTask/byWorkspace ordering by createdAt asc.

- [ ] **Step 4a.2.3: Implement queue in-memory. ~200 lines. Checkpoint.**

### Task 4a.3: Audit log persistence — both enqueue AND decide events

(Codex finding #17: pending requests would be lost on restart. Solution: persist both enqueue and decide events.)

**Files:**
- Create: `src/terminal/approval-audit-log.ts`
- Test: `test/runtime/terminal/approval-audit-log.test.ts`
- Modify: `src/terminal/supervisor-approval-queue.ts` to write through the audit log

- [ ] **Step 4a.3.1: TDD the audit log**

JSONL events shape (use `kind:` here — this is internal log schema, NOT the runtime-state-stream WS schema, so no naming clash):
```ts
type AuditEvent =
  | { kind: "enqueue"; request: RuntimeApprovalRequest }
  | { kind: "decide"; id: string; status: RuntimeApprovalDecision; decidedBy: "policy" | "user"; decidedAt: number };
```

Path: `join(getAuditHomePath(), "approvals.jsonl")`. (`getAuditHomePath` was added in Task 3.0.)

Tests: append + replay reconstructs full queue state (including pending entries that never got a decide event).

Add rotation (codex finding #20): cap at `~10MB`, rotate to `approvals.1.jsonl`, retain up to 5 historical files, GC older.

- [ ] **Step 4a.3.2: Implement.** Reuse `OutputJournal`-style internal queue pattern for serialization safety.

- [ ] **Step 4a.3.3: Wire queue → audit on every state change.**

- [ ] **Step 4a.3.4: Replay on queue construction.** On startup, fold all events into the in-memory queue.

- [ ] **Step 4a.3.5: Checkpoint.**

### Task 4a.4: Persist `workspaceId` on `SessionEntry` (private to manager)

The session-manager already accepts `workspaceId` on `StartTaskSessionRequest` ([session-manager.ts:108](../../src/terminal/session-manager.ts:108)) and forwards it to `prepareAgentLaunch` ([session-manager.ts:360](../../src/terminal/session-manager.ts:360)) — but it doesn't store it on `SessionEntry`. We need it for queue.enqueue and WS broadcasts.

**Crucially: do NOT add `workspaceId` to `RuntimeTaskSessionSummary`** — that's a public API/Zod schema and changing it ripples across clients. Add it to private `SessionEntry` only and expose via a new manager method `getWorkspaceId(taskId): string | null`.

**Files:**
- Modify: [src/terminal/session-manager.ts](../../src/terminal/session-manager.ts) — add private `workspaceId: string | null` to `SessionEntry`; populate at start; thread through `hydrateFromRecord(..., workspaceId)`
- Modify: [src/server/workspace-registry.ts](../../src/server/workspace-registry.ts) — pass workspaceId argument to hydrate
- Test: extend session-manager tests

- [ ] **Step 4a.4.1: Failing test — after start, `mgr.getWorkspaceId(taskId)` returns the workspaceId; before start (or after hydrate without workspaceId) returns `null`.**

- [ ] **Step 4a.4.2: Add the field; populate in start path; thread through hydrate. Add `getWorkspaceId` method.**

- [ ] **Step 4a.4.3: Checkpoint.**

### Task 4a.5: Construct + inject queue at CLI startup (correct boot order)

The queue is a process-singleton constructed in `cli.ts` BEFORE `createWorkspaceRegistry`, then threaded through. Boot order in [src/cli.ts:336](../../src/cli.ts:336):

```
cli.ts construction order (current):
  1. createWorkspaceRegistry(...)   — line 336
  2. createRuntimeStateHub(...)     — line 346
  3. createRuntimeServer(...)       — line 367

cli.ts construction order (after this task):
  0. const approvalQueue = new SupervisorApprovalQueue(...);
  1. createWorkspaceRegistry({ ..., approvalQueue })
  2. createRuntimeStateHub({ ..., approvalQueue })
  3. createRuntimeServer({ ..., approvalQueue })
```

**Files:**
- Modify: [src/cli.ts](../../src/cli.ts) — construct queue before registry, thread through
- Modify: [src/server/workspace-registry.ts](../../src/server/workspace-registry.ts) — accept `approvalQueue` in deps; pass to each `TerminalSessionManager`
- Modify: [src/terminal/session-manager.ts](../../src/terminal/session-manager.ts) — accept queue in constructor
- Modify: [src/server/runtime-state-hub.ts](../../src/server/runtime-state-hub.ts) — accept queue, subscribe to events for broadcast
- Modify: [src/server/runtime-server.ts](../../src/server/runtime-server.ts) and [src/trpc/runtime-api.ts](../../src/trpc/runtime-api.ts) — accept queue via dependency chain into `RuntimeTrpcContext.runtimeApi`

- [ ] **Step 4a.5.1: Add `approvalQueue` to each consumer's construction signature. Build incrementally: first runtime-server/api, then registry, then session-manager. Each step keeps `npm run check` green.**

- [ ] **Step 4a.5.2: For tests, expose a `createTestApprovalQueue()` factory at `test/runtime/terminal/test-helpers.ts` (or extend an existing helpers file) so each consumer's test uses the same in-memory queue.**

- [ ] **Step 4a.5.3: Checkpoint.**

### Task 4a.6: Replace `maybeAutoApprovePendingPrompt` with queue-driven flow

**Files:**
- Modify: [src/terminal/session-manager.ts:805](../../src/terminal/session-manager.ts:805)
- Test: extend [test/runtime/terminal/session-manager.test.ts](../../test/runtime/terminal/session-manager.test.ts)

When a session enters `awaiting_review` AND `latestHookActivity` is a permission-prompt activity (use `isPermissionPromptActivity` already defined in [agent-approval-policy.ts:43](../../src/terminal/agent-approval-policy.ts:43)):

1. Compute fingerprint via `buildHookActivityFingerprint`.
2. `queue.enqueue({ taskId, workspaceId: entry.workspaceId, agentId: entry.summary.agentId, activity, fingerprint, autoDecision: evaluateSupervisedApproval(activity) })`.
3. If `entry.active.approvalMode === "supervised"` AND `autoDecision.shouldAutoApprove`:
   - `queue.decide(req.id, "auto_approved", "policy")`
   - Schedule the existing PTY `\r` write (preserve `SUPERVISED_APPROVAL_DELAY_MS`).
4. Otherwise leave request `pending`.

Add an `applyDecision(requestId: string, decision: "approved" | "denied"): RuntimeApprovalRequest | null` method on `TerminalSessionManager` that:
- Looks up the request via the queue. If not found OR not pending, returns `null`.
- Validates the entry has an active session. If absent, returns `null` (caller maps to 404/409).
- Calls `queue.decide(requestId, "user_approved" | "user_denied", "user")`.
- For approved: writes the agent's approve keystroke (codex: `\r`; claude: verify exact key by inspecting a real permission prompt — likely `1\r`).
- For denied: writes the deny keystroke (codex: per existing convention; claude: typically `2\r` or Esc).
- Returns the updated `RuntimeApprovalRequest` from the queue.

Workspace-mismatch protection: the runtime-api's `decide` resolves the manager via `workspaceRegistry.getManager(workspaceId)`, and `applyDecision` only operates on its own queue scope, so a request belonging to a different workspace returns `null` (caller maps to 403/404).

Document the keystroke-per-agent map as a constant in `src/terminal/agent-approval-policy.ts`:

```ts
export const APPROVE_KEYSTROKES: Record<RuntimeAgentId, { approve: string; deny: string }> = {
  codex: { approve: "\r", deny: "" },  // Esc to back out
  claude: { approve: "1\r", deny: "2\r" },
};
```

(Verify these by reading the actual prompt output before claiming done. If the codebase already has approval keystrokes defined elsewhere, REUSE rather than redefining — search first: `grep -rn "approve.*key\|deny.*key\|\\\\r.*approve" src/`.)

This addresses codex finding #18 (decision execution path).

- [ ] **Step 4a.6.1: Failing tests covering all four paths (auto-approve, manual approve, manual deny, idempotency).**

- [ ] **Step 4a.6.2: Implement.**

- [ ] **Step 4a.6.3: Verify per-agent keystrokes by reading the actual approval format. Document the keystroke choice in `agent-approval-policy.ts` as a const map.**

- [ ] **Step 4a.6.4: Checkpoint.**

### Task 4a.7: Broadcast queue events through `runtime-state-hub`

(Codex finding #16: don't use tRPC subscriptions; the existing hub uses raw WebSocket.)

**Files:**
- Modify: [src/server/runtime-state-hub.ts](../../src/server/runtime-state-hub.ts)
- Modify: [src/core/api-contract.ts](../../src/core/api-contract.ts) — add WS message variants
- Test: extend `test/runtime/server/runtime-state-hub.test.ts` if it exists, or create

- [ ] **Step 4a.7.1: Add new `RuntimeStateStreamMessage` variants — discriminator is `type:` (mirrors existing variants like `task_ready_for_review`):**

```ts
| { type: "approval_request_queued"; workspaceId: string; request: RuntimeApprovalRequest }
| { type: "approval_request_decided"; workspaceId: string; request: RuntimeApprovalRequest }
```

Use snake_case for the type values to match existing message variants (`workspace_metadata_updated`, `projects_updated`, `task_sessions_updated`, `aggregate_board_updated`, etc.).

- [ ] **Step 4a.7.2: Add `broadcastApprovalRequestQueued` and `broadcastApprovalRequestDecided` to the hub, mirroring `broadcastTaskReadyForReview` at line 437.**

- [ ] **Step 4a.7.3: Wire queue listener: on enqueue → broadcast queued; on decide → broadcast decided.**

- [ ] **Step 4a.7.4: Checkpoint.**

### Task 4a.8: tRPC procedures for listing + deciding (no subscriptions)

tRPC procedures are split between the implementation file (`src/trpc/runtime-api.ts`) and the router registration (`src/trpc/app-router.ts`). Both must change. The runtime API uses the typed `RuntimeTrpcContext["runtimeApi"]` indirection, so we extend that interface as well.

**Files:**
- Modify: [src/core/api-contract.ts](../../src/core/api-contract.ts) — input/output schemas for the three procedures
- Modify: [src/trpc/runtime-api.ts](../../src/trpc/runtime-api.ts) — implementation (wired through `RuntimeTrpcContext.runtimeApi`)
- Modify: [src/trpc/app-router.ts](../../src/trpc/app-router.ts) — register the procedures under `runtime.approvals.*`
- Test: extend [test/runtime/trpc/runtime-api.test.ts](../../test/runtime/trpc/runtime-api.test.ts)

- [ ] **Step 4a.8.1: Add input/output schemas to `api-contract.ts`:**

```ts
export const runtimeApprovalsListInputSchema = z.object({
  workspaceId: z.string(),
});
export const runtimeApprovalsListResponseSchema = z.object({
  pending: z.array(runtimeApprovalRequestSchema),
  recent: z.array(runtimeApprovalRequestSchema),
});

export const runtimeApprovalsDecideInputSchema = z.object({
  workspaceId: z.string(),
  requestId: z.string(),
  decision: z.enum(["approved", "denied"]),
});
export const runtimeApprovalsHistoryInputSchema = z.object({
  workspaceId: z.string(),
  limit: z.number().int().positive().max(500).optional(),
});
```

- [ ] **Step 4a.8.2: Extend the `runtimeApi` shape on `RuntimeTrpcContext` (in `app-router.ts`) with three new methods, and provide the implementations in `runtime-api.ts`. Register procedures `runtime.approvals.list / decide / history` in `app-router.ts`.**

```
runtime.approvals.list    query    → { pending, recent }
runtime.approvals.decide  mutation → RuntimeApprovalRequest
runtime.approvals.history query    → RuntimeApprovalRequest[]
```

**Critical: `decide` must invoke `TerminalSessionManager.applyDecision(requestId, decision)` so the PTY actually receives the approve/deny keystroke.** A queue-only update (without `applyDecision`) marks the request decided but the agent never gets unstuck. The runtime-api implementation should:

```ts
decide: async ({ workspaceId, requestId, decision }) => {
  const manager = await deps.workspaceRegistry.getManager(workspaceId);
  const result = manager.applyDecision(requestId, decision);
  if (!result) throw new TRPCError({ code: "NOT_FOUND" });
  return result;
}
```

- [ ] **Step 4a.8.3: Tests for happy paths + invariants:**
  - Deciding a pending request returns the updated `RuntimeApprovalRequest`.
  - Deciding a non-pending id (already decided) → tRPC error `NOT_FOUND`.
  - Deciding a request that belongs to a different workspace → tRPC error `NOT_FOUND` (no info-leak; unique behavior is fine).
  - `list` returns pending sorted asc by createdAt.
  - `history` honors `limit`.

- [ ] **Step 4a.8.4: Checkpoint.**

---

## Chunk 4b: Phase 4b — Supervisor UI Panel

(Frontend half. Independent unit of review.)

**Files:**
- Create: `web-ui/src/runtime/use-approval-queue.ts`
- Create: `web-ui/src/components/supervisor-panel.tsx`
- Test: `web-ui/src/components/supervisor-panel.test.tsx`
- Modify: [web-ui/src/App.tsx](../../web-ui/src/App.tsx) — mount panel, add nav entry
- Modify: [web-ui/src/runtime/use-runtime-state-stream.ts](../../web-ui/src/runtime/use-runtime-state-stream.ts) — handle new WS message variants
- Modify: [web-ui/src/components/runtime-settings-dialog.tsx](../../web-ui/src/components/runtime-settings-dialog.tsx) — point supervised-mode helptext at the new panel (locate the actual setting; codex finding #21 — DO NOT trust line numbers)

### Task 4b.1: Extend `useRuntimeStateStream` + create `use-approval-queue`

[useRuntimeStateStream](../../web-ui/src/runtime/use-runtime-state-stream.ts:43) currently only exposes processed state and `latestTaskReadyForReview`. It does NOT surface arbitrary WS messages to other hooks. We have two options:

**(a)** Open a separate WebSocket subscription inside `useApprovalQueue` (cleanest separation but doubles connection count).
**(b)** Extend `useRuntimeStateStream` with a reducer-managed `approvalQueueState: { pending: [], recent: [] }` and a corresponding selector.

**Choose (b)** — single connection, consistent reconnect semantics. The hook stays small; the new state lives in the existing reducer in `use-runtime-state-stream.ts`.

**Files:**
- Modify: [web-ui/src/runtime/use-runtime-state-stream.ts](../../web-ui/src/runtime/use-runtime-state-stream.ts) — extend reducer state to track approval queue + recent decisions; handle `approval_request_queued` / `approval_request_decided` actions
- Create: `web-ui/src/runtime/use-approval-queue.ts` — selector hook + decide mutation
- Test: `web-ui/src/runtime/use-approval-queue.test.tsx`

- [ ] **Step 4b.1.1: TDD the reducer**

In `use-runtime-state-stream.test.tsx` (or whichever already exists for the stream), extend tests:
- Receiving `{ type: "approval_request_queued", workspaceId, request }` adds the request to `state.approvalQueueState.pending` for that workspace.
- Receiving `{ type: "approval_request_decided", ... }` removes from pending (if present) and adds to `recent` (capped at 20).

- [ ] **Step 4b.1.2: Implement reducer cases. Snake_case must match backend exactly: `approval_request_queued`, `approval_request_decided`.**

- [ ] **Step 4b.1.3: Implement `useApprovalQueue(workspaceId)`**

`useRuntimeStateStream(requestedWorkspaceId)` already takes a workspace argument and returns the processed state. Extend its return shape with `approvalQueueState: { pending, recent }` (already added in Step 4b.1.2). The new hook reads only:

```ts
import { useEffect, useCallback } from "react";
import { useRuntimeStateStream } from "@/runtime/use-runtime-state-stream";
import { runtimeTrpc } from "@/runtime/trpc-client";
import type { RuntimeApprovalRequest } from "@/runtime/types";

export function useApprovalQueue(workspaceId: string | null): {
  pending: readonly RuntimeApprovalRequest[];
  recent: readonly RuntimeApprovalRequest[];
  decide: (requestId: string, decision: "approved" | "denied") => Promise<void>;
} {
  const stream = useRuntimeStateStream(workspaceId);
  const dispatchSeedApprovals = stream.dispatchSeedApprovals; // stable callback, see below
  // Initial seed: dispatch a `seed_approvals` reducer action with the result of runtime.approvals.list.
  // The reducer cases for queued/decided take it from there.
  useEffect(() => {
    if (!workspaceId || !dispatchSeedApprovals) return;
    let cancelled = false;
    runtimeTrpc.runtime.approvals.list.query({ workspaceId }).then((res) => {
      if (cancelled) return;
      dispatchSeedApprovals(res);
    });
    return () => { cancelled = true; };
  }, [workspaceId, dispatchSeedApprovals]);

  const decide = useCallback(
    async (requestId: string, decision: "approved" | "denied") => {
      if (!workspaceId) return;
      await runtimeTrpc.runtime.approvals.decide.mutate({ workspaceId, requestId, decision });
    },
    [workspaceId],
  );

  return {
    pending: stream.approvalQueueState?.pending ?? [],
    recent: stream.approvalQueueState?.recent ?? [],
    decide,
  };
}
```

The stream hook's return must therefore expose:
- `approvalQueueState: { pending: RuntimeApprovalRequest[]; recent: RuntimeApprovalRequest[] }`
- `dispatchSeedApprovals: (input: { pending; recent }) => void` — wrapped in `useCallback`/`useRef` inside `useRuntimeStateStream` so it's identity-stable across renders. Without this, the seeding `useEffect` re-fires on every render.

Add a reducer action `{ type: "seed_approvals"; pending; recent }` that overwrites the lists (used by the initial fetch). The WS-driven `approval_request_queued` / `approval_request_decided` actions update incrementally.

(`runtimeTrpc` is the actual export name from [web-ui/src/runtime/trpc-client.ts](../../web-ui/src/runtime/trpc-client.ts) — verify and use whatever name is exported, e.g. `runtimeApi`/`runtimeTrpc`/`trpc`.)

- [ ] **Step 4b.1.4: Checkpoint.**

### Task 4b.2: SupervisorPanel component

- [ ] **Step 4b.2.1: TDD render contract.**

Render:
- Header: "Supervisor" + count badge of pending.
- Pending list: each row shows agent icon, task title (looked up from board), tool name + 200-char input summary, auto-decision reason ("auto-approved: read_only_tool" / "needs review: unsupported_tool"), Approve / Deny buttons.
- Collapsed history (last 20).
- Empty state: "No pending approvals."
- Loading / error states.

Style with design tokens: `bg-surface-1` panel, `bg-surface-2` rows, `text-status-orange` pending, `text-status-green` approved, `text-status-red` denied.

- [ ] **Step 4b.2.2: Implement using existing UI primitives (`Button`, `Tooltip`, Radix `Collapsible`, lucide icons).**

- [ ] **Step 4b.2.3: Checkpoint.**

### Task 4b.3: Mount in App.tsx; nav entry

- [ ] **Step 4b.3.1: Add nav entry "Supervisor" with `<ShieldCheck>` icon. Show pending count badge when > 0. Open as a right-side drawer using existing drawer/panel pattern.**

- [ ] **Step 4b.3.2: Update use-runtime-state-stream.ts to surface the new WS messages.**

- [ ] **Step 4b.3.3: Checkpoint.**

### Task 4b.4: Settings dialog helptext + onboarding

- [ ] **Step 4b.4.1: Locate the actual `value: "supervised"` and surrounding helptext in the dialog. Update text to point at the panel: "Supervised mode auto-approves narrow read-only prompts and queues anything else for review in the Supervisor panel (top nav)."**

- [ ] **Step 4b.4.2: One-time toast suggesting Supervised mode if user is on `manual` after >24h of usage. Use the existing `use-startup-onboarding` hook pattern.**

- [ ] **Step 4b.4.3: Checkpoint.**

---

## Chunk 5: Final Integration Validation

### Task 5.1: Full check

- [ ] **Step 5.1.1: Run** `npm run check` — all green.
- [ ] **Step 5.1.2: Run** `npm run build` — no errors.

### Task 5.2: Manual smoke checklist (queued for the user)

A list of UI steps the user runs after restarting their runtime:

1. **Cleanup button regression test:** Click Sparkles on a backlog with ≥1 task while the sidebar agent is at its prompt. Should run cleanup, not toast "already running".
2. **Restart-agent escape:** Force the sidebar agent into a stuck state (kill its process). Click the new restart button. Confirm a fresh process starts.
3. **Chat persistence:** Type messages in a task chat. Restart the runtime. Reopen the task. Verify history reappears.
4. **Supervised auto-approve:** Switch to Supervised mode. Trigger a read-only operation. Verify (a) PTY proceeds without manual click, (b) Supervisor panel shows entry under history with reason `auto-approved: read_only_tool`.
5. **Supervised manual approve:** In Supervised mode, trigger a write operation. Verify it sits as `pending` in the panel. Click Approve. Verify the agent proceeds.
6. **Supervised manual deny:** Trigger another write op. Click Deny. Verify the agent backs off.
7. **Audit replay:** Restart runtime. Open Supervisor panel. Verify history is preserved.

### Task 5.3: Document done-state in plan

- [ ] **Step 5.3.1: Append a one-line entry per phase to a `## Verification Log` section at the bottom of this plan, with date and outcome.**

---

## Risks & Mitigations (revised)

| Risk | Mitigation |
|---|---|
| **R1: Idempotency tests pass on weak conditions** (codex #2) | Tests now exercise the actual duplicate condition: a `running` summary with the marker activity already set. |
| **R2: PID liveness false positives** (codex #6) | We don't use `process.kill`. After runtime restart, `active === null` for every entry, so any `state === "running"` is by definition stale. |
| **R3: Journal ordering / lost writes under PTY load** (codex #11) | `OutputJournal.append` uses an internal `writeChain` promise; `close()` awaits it; PTY hot path doesn't wait. |
| **R4: Audit log unbounded growth** (codex #20) | Rotation at ~10MB; retain 5 historical files; GC older. |
| **R5: Pending requests lost on runtime restart** (codex #17) | Audit log records both `enqueue` and `decide` events; queue is reconstructed on construction. |
| **R6: Manual approve/deny with no execution path** (codex #18) | `applyDecision` on TerminalSessionManager owns the PTY-write side; tests assert per-agent keystroke is sent. |
| **R7: tRPC subscriptions not wired** (codex #16) | We use the existing `runtime-state-hub` WebSocket and add new message variants instead of adding a subscription transport. |
| **R8: Plan executor commits** (codex #25) | Plan explicitly forbids `git commit`. Each task ends with `npm run check` + brief written status. |
| **R9: Effort underestimate on Phase 4** (codex #24) | Phase 4 split into 4a (backend) and 4b (frontend); each independently shippable. |
| **R10: GC deletes restorable trash data** (codex Rev2 #6) | Journal GC fires only on permanent `deleteWorktree`, NOT on `task trash` (which is reversible). |
| **R11: Detector test signature mismatch** (codex Rev2 #2) | Tests pass `string`, not `Buffer`, and use existing `makeLaunchInput`/`makeSummary` helpers. |
| **R12: Reconciliation duplicating existing code** (codex Rev2 #1) | Phase 1.4 reduced to verification-only; the existing `normalizeStaleSessionSummary` is correct (`state: "interrupted"`). |
| **R13: Workspace ID not on SessionEntry** (codex Rev2 #9) | Phase 4a.4 adds `workspaceId` to `SessionEntry` and threads it through hydrate. |

## Out of Scope

- Removing the in-memory ring buffer (still needed for low-latency replay; journal is the durable backing store).
- LLM-backed supervisor decision-making (current `evaluateSupervisedApproval` is a static policy — that's a separate research task).
- Renaming `agentAutonomousModeEnabled` to clean up the legacy bypass flag.
- Per-task cleanup confidence metadata.
- Sync of `codex/fs-kanban-foundation` ref to current main.

## References (verified post-rebase to `42851ab`)

- Plan that started this work: [.plan/docs/backlog-cleanup-and-supervised-auto-mode-plan.md](backlog-cleanup-and-supervised-auto-mode-plan.md)
- Existing approval policy: [src/terminal/agent-approval-policy.ts](../../src/terminal/agent-approval-policy.ts)
- State machine reducer: [src/terminal/session-state-machine.ts](../../src/terminal/session-state-machine.ts)
- Codex prompt detector: [src/terminal/agent-session-adapters.ts:271](../../src/terminal/agent-session-adapters.ts:271)
- Sparkles cleanup button: [web-ui/src/components/board-column.tsx:110](../../web-ui/src/components/board-column.tsx:110)
- Cleanup handler: [web-ui/src/App.tsx:712](../../web-ui/src/App.tsx:712)
- Existing silent auto-approver: [src/terminal/session-manager.ts:805](../../src/terminal/session-manager.ts:805)
- Hydrate path: [src/terminal/session-manager.ts:255](../../src/terminal/session-manager.ts:255)
- Workspace registry call site: [src/server/workspace-registry.ts:307](../../src/server/workspace-registry.ts:307)
- WebSocket hub broadcasts: [src/server/runtime-state-hub.ts:437](../../src/server/runtime-state-hub.ts:437)
- PTY history primitives: [src/terminal/pty-session.ts:107](../../src/terminal/pty-session.ts:107), [pty-session.ts:162](../../src/terminal/pty-session.ts:162)

## Verification Log

- **2026-05-01** — Phase 0 complete: worktree rebased onto `origin/main` (`42851ab`).
- **2026-05-01** — Phase 1 complete (Tasks 1.1–1.4): `agent.needs-input` event, codex + Claude prompt detectors, idempotent reducer behavior, stuck-`running` reconciliation tests verified. 235 tests passing.
- **2026-05-01** — Phase 2 complete (Tasks 2.1–2.2): `restartSession` exposed from `useHomeAgentSession`, `Restart board agent` button, "Clean up" label.
- **2026-05-01** — Phase 3 complete (Tasks 3.0–3.5): journal helpers, `OutputJournal` (rotation-restart-safe + workspace namespace), `outputSink` on PtySession, `TerminalSessionManager` workspace journal ownership, `replayHistoryByTaskId` journal-first, `MAX_HISTORY_BYTES` cap, `preserveJournal: true` default with permanent-delete callers updated, project-removal recursive journal-dir cleanup. 247 tests passing.
- **2026-05-01** — Phase 4a complete (Tasks 4a.1–4a.8): Claude `PermissionRequest` includes `notificationType: permission_prompt`. `RuntimeApprovalRequest` schema + WS message variants in api-contract. `SupervisorApprovalQueue` (8 tests). `ApprovalAuditLog` with rotation + replay (4 tests). Queue + audit log constructed at CLI boot, injected into workspace-registry → managers, runtime-state-hub, runtime-api. `maybeAutoApprovePendingPrompt` extended to enqueue requests; `applyDecision` returns `RuntimeApprovalRequest | null` with PTY keystroke per agent (codex `\r`, claude `1\r`/`2\r`). `runtime.approvals.list/decide/history` tRPC procedures registered in `app-router.ts`.
- **2026-05-01** — Phase 4b complete (Tasks 4b.1–4b.2): `useRuntimeStateStream` extended with `approvalQueueState` + stable `dispatchSeedApprovals` callback; `approval_request_queued` and `approval_request_decided` reducer cases. `useApprovalQueue` hook with initial seed via `runtime.approvals.list`. `SupervisorPanel` component using design tokens, pending list with Approve/Deny, collapsible recent decisions. Top-bar `ShieldCheck` button with pending-count badge mounts the panel as a Dialog.
- **2026-05-01** — Final verification: `npm run check` clean (lint + typecheck + 261 tests passing across 43 files); `npm run build` clean (web-ui + tsc + dist).
