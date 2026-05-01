import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract.js";
import { buildShellCommandLine } from "../../../src/core/shell.js";
import { OutputJournal } from "../../../src/terminal/output-journal.js";
import { MAX_HISTORY_BYTES } from "../../../src/terminal/pty-session.js";
import { TerminalSessionManager } from "../../../src/terminal/session-manager.js";

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		workspacePath: "/tmp/worktree",
		pid: 1234,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: Date.now(),
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		...overrides,
	};
}

async function waitForReplayText(dir: string, taskId: string, expected: string): Promise<string> {
	const deadline = Date.now() + 5_000;
	let text = "";
	while (Date.now() < deadline) {
		const replay = await OutputJournal.replay({ dir, taskId });
		text = Buffer.concat(replay).toString("utf8");
		if (text.includes(expected)) {
			return text;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return text;
}

describe("TerminalSessionManager", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("accepts a workspaceJournalDir option", () => {
		const manager = new TerminalSessionManager({ workspaceJournalDir: "/tmp/fs-kanban-test-journals" });

		expect(manager.listSummaries()).toEqual([]);
	});

	it("writes configured shell session output to an OutputJournal", async () => {
		const dir = await mkdtemp(join(tmpdir(), "fs-kanban-manager-journal-"));
		try {
			const manager = new TerminalSessionManager({ workspaceJournalDir: dir });
			const taskId = "task-journal";
			let detach: (() => void) | null = null;
			const exited = new Promise<number | null>((resolve) => {
				detach = manager.attach(taskId, {
					onExit: (exitCode) => {
						detach?.();
						resolve(exitCode);
					},
				});
			});

			await manager.startShellSession({
				taskId,
				cwd: dir,
				binary: process.execPath,
				args: ["-e", "process.stdout.write('journal-output')"],
			});

			expect(await exited).toBe(0);
			const replayText = await waitForReplayText(dir, taskId, "journal-output");
			expect(replayText).toContain("journal-output");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("hydrateFromRecord stores workspaceId for getWorkspaceId(taskId)", () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord(
			{
				"task-1": createSummary({ taskId: "task-1", state: "running" }),
			},
			{},
			"ws-foo",
		);
		expect(manager.getWorkspaceId("task-1")).toBe("ws-foo");
		expect(manager.getWorkspaceId("missing")).toBeNull();
	});

	it("getWorkspaceId returns null when workspaceId was not provided to hydrate", () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({
			"task-1": createSummary({ taskId: "task-1", state: "running" }),
		});
		expect(manager.getWorkspaceId("task-1")).toBeNull();
	});

	it("clears trust prompt state when transitioning to review", () => {
		const manager = new TerminalSessionManager();
		const entry = {
			summary: createSummary({ state: "running", reviewReason: null }),
			active: {
				workspaceTrustBuffer: "trust this folder",
				awaitingCodexPromptAfterEnter: true,
			},
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		const applySessionEvent = (
			manager as unknown as {
				applySessionEvent: (sessionEntry: unknown, event: { type: "hook.to_review" }) => RuntimeTaskSessionSummary;
			}
		).applySessionEvent;
		const nextSummary = applySessionEvent(entry, { type: "hook.to_review" });
		expect(nextSummary.state).toBe("awaiting_review");
		expect(entry.active.workspaceTrustBuffer).toBe("");
	});

	it("builds shell kickoff command lines with quoted arguments", () => {
		const commandLine = buildShellCommandLine("codex", ["--dangerously-bypass-approvals-and-sandbox", "hello world"]);
		expect(commandLine).toContain("codex");
		expect(commandLine).toContain("--dangerously-bypass-approvals-and-sandbox");
		expect(commandLine).toContain("hello world");
	});

	it("stores hook activity metadata on sessions", () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({
			"task-1": createSummary({ state: "running" }),
		});

		const updated = manager.applyHookActivity("task-1", {
			source: "claude",
			activityText: "Using Read",
			toolName: "Read",
		});

		expect(updated?.latestHookActivity?.source).toBe("claude");
		expect(updated?.latestHookActivity?.activityText).toBe("Using Read");
		expect(updated?.latestHookActivity?.toolName).toBe("Read");
		expect(typeof updated?.lastHookAt).toBe("number");
	});

	it("hydrates persisted active sessions as interrupted", () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({
			"task-1": createSummary({ state: "running" }),
		});

		const hydrated = manager.getSummary("task-1");

		expect(hydrated?.state).toBe("interrupted");
		expect(hydrated?.pid).toBeNull();
		expect(hydrated?.agentId).toBe("claude");
		expect(hydrated?.workspacePath).toBe("/tmp/worktree");
		expect(hydrated?.reviewReason).toBe("interrupted");
	});

	it("hydrateFromRecord demotes a running summary to interrupted (no PTY exists post-restart)", () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({
			"t-zombie": createSummary({ taskId: "t-zombie", state: "running", pid: 999999 }),
		});
		const after = manager.getSummary("t-zombie");
		expect(after?.state).toBe("interrupted");
		expect(after?.reviewReason).toBe("interrupted");
		expect(after?.pid).toBeNull();
	});

	it("hydrateFromRecord also demotes awaiting_review to interrupted (active state without process)", () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({
			"t-await": createSummary({ taskId: "t-await", state: "awaiting_review", reviewReason: "attention", pid: 1 }),
		});
		expect(manager.getSummary("t-await")?.state).toBe("interrupted");
	});

	it("hydrateFromRecord leaves non-active states untouched", () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({
			"t-ok": createSummary({ taskId: "t-ok", state: "interrupted", reviewReason: "exit", pid: null }),
		});
		expect(manager.getSummary("t-ok")?.state).toBe("interrupted");
		expect(manager.getSummary("t-ok")?.reviewReason).toBe("exit");
	});

	it("hydrates persisted replay output history for interrupted sessions", () => {
		const manager = new TerminalSessionManager();
		const onOutput = vi.fn();
		manager.hydrateFromRecord(
			{
				"task-1": createSummary({ state: "running" }),
			},
			{
				"task-1": [Buffer.from("persisted output", "utf8")],
			},
		);

		manager.attach("task-1", {
			onOutput,
		});

		expect(onOutput).toHaveBeenCalledTimes(1);
		expect((onOutput.mock.calls[0]?.[0] as Buffer).toString("utf8")).toBe("persisted output");
		expect(manager.getSummary("task-1")?.state).toBe("interrupted");
	});

	it("caps hydrated replay output history to the latest bytes", () => {
		const manager = new TerminalSessionManager();
		const staleChunk = Buffer.from("stale:", "utf8");
		const fillerChunk = Buffer.alloc(MAX_HISTORY_BYTES - 4, "m");
		const latestChunk = Buffer.from("latest", "utf8");

		manager.hydrateFromRecord(
			{
				"task-1": createSummary({ state: "running" }),
			},
			{
				"task-1": [staleChunk, fillerChunk, latestChunk],
			},
		);

		const history = manager.listReplayHistories()["task-1"] ?? [];
		const replay = Buffer.concat(history);

		expect(replay.byteLength).toBe(MAX_HISTORY_BYTES);
		expect(replay.toString("utf8").endsWith("latest")).toBe(true);
		expect(replay.toString("utf8")).not.toContain("stale:");
		expect(history.at(-1)?.toString("utf8")).toBe("latest");
	});

	it("recovers stale running sessions without active processes as interrupted", () => {
		const manager = new TerminalSessionManager();
		(
			manager as unknown as {
				entries: Map<
					string,
					{
						summary: RuntimeTaskSessionSummary;
						active: null;
						replayOutputHistory: Buffer[];
						listenerIdCounter: number;
						listeners: Map<number, unknown>;
						restartRequest: null;
						suppressAutoRestartOnExit: boolean;
						autoRestartTimestamps: number[];
						pendingAutoRestart: null;
					}
				>;
			}
		).entries.set("task-1", {
			summary: createSummary({ state: "running" }),
			active: null,
			replayOutputHistory: [],
			listenerIdCounter: 1,
			listeners: new Map(),
			restartRequest: null,
			suppressAutoRestartOnExit: false,
			autoRestartTimestamps: [],
			pendingAutoRestart: null,
		});

		const recovered = manager.recoverStaleSession("task-1");

		expect(recovered?.state).toBe("interrupted");
		expect(recovered?.pid).toBeNull();
		expect(recovered?.agentId).toBe("claude");
		expect(recovered?.workspacePath).toBe("/tmp/worktree");
		expect(recovered?.reviewReason).toBe("interrupted");
	});

	it("tracks only the latest two turn checkpoints", () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({
			"task-1": createSummary({ state: "running" }),
		});

		manager.applyTurnCheckpoint("task-1", {
			turn: 1,
			ref: "refs/kanban/checkpoints/task-1/turn/1",
			commit: "1111111",
			createdAt: 1,
		});
		manager.applyTurnCheckpoint("task-1", {
			turn: 2,
			ref: "refs/kanban/checkpoints/task-1/turn/2",
			commit: "2222222",
			createdAt: 2,
		});

		const summary = manager.getSummary("task-1");
		expect(summary?.latestTurnCheckpoint?.turn).toBe(2);
		expect(summary?.previousTurnCheckpoint?.turn).toBe(1);
	});

	it("replies to OSC 11 probe from replayed output history and hides the query", () => {
		const manager = new TerminalSessionManager();
		const onOutput = vi.fn();
		const writeSpy = vi.fn();
		const entry = {
			summary: createSummary({ taskId: "task-probe", state: "running" }),
			active: {
				session: {
					getOutputHistory: () => [Buffer.from("\u001b]11;?\u0007", "utf8"), Buffer.from("ready", "utf8")],
					write: writeSpy,
				},
				terminalProtocolFilter: {
					pendingChunk: null,
					interceptOsc11BackgroundQueries: true,
					suppressDeviceAttributeQueries: false,
				},
			},
			replayOutputHistory: [],
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(
			manager as unknown as {
				entries: Map<string, typeof entry>;
			}
		).entries.set("task-probe", entry);

		manager.attach("task-probe", {
			onOutput,
		});

		expect(writeSpy).toHaveBeenCalledWith("\u001b]11;rgb:1717/1717/2121\u001b\\");
		expect(onOutput).toHaveBeenCalledTimes(1);
		expect((onOutput.mock.calls[0]?.[0] as Buffer).toString("utf8")).toBe("ready");
		expect(entry.active.terminalProtocolFilter.interceptOsc11BackgroundQueries).toBe(false);
		expect(entry.active.terminalProtocolFilter.pendingChunk).toBeNull();
	});

	it("keeps the startup probe filter enabled when only a non-output listener attaches", () => {
		const manager = new TerminalSessionManager();
		const entry = {
			summary: createSummary({ taskId: "task-control-first", state: "running" }),
			active: {
				session: {
					getOutputHistory: () => [Buffer.from("\u001b]11;?\u0007", "utf8")],
					write: vi.fn(),
				},
				terminalProtocolFilter: {
					pendingChunk: null,
					interceptOsc11BackgroundQueries: true,
					suppressDeviceAttributeQueries: false,
				},
			},
			replayOutputHistory: [],
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(
			manager as unknown as {
				entries: Map<string, typeof entry>;
			}
		).entries.set("task-control-first", entry);

		manager.attach("task-control-first", {
			onState: vi.fn(),
			onExit: vi.fn(),
		});

		expect(entry.active.terminalProtocolFilter.interceptOsc11BackgroundQueries).toBe(true);
		expect(entry.active.terminalProtocolFilter.pendingChunk).toBeNull();
	});

	it("forwards pixel dimensions through resize when provided", () => {
		const manager = new TerminalSessionManager();
		const resizeSpy = vi.fn();
		const entry = {
			summary: createSummary({ taskId: "task-resize", state: "running" }),
			active: {
				session: {
					resize: resizeSpy,
				},
				cols: 80,
				rows: 24,
			},
			replayOutputHistory: [],
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(
			manager as unknown as {
				entries: Map<string, typeof entry>;
			}
		).entries.set("task-resize", entry);

		const resized = manager.resize("task-resize", 100, 30, 1200, 720);
		expect(resized).toBe(true);
		expect(resizeSpy).toHaveBeenCalledWith(100, 30, 1200, 720);
	});

	it("replays cached output history for interrupted sessions without an active process", () => {
		const manager = new TerminalSessionManager();
		const onOutput = vi.fn();
		const entry = {
			summary: createSummary({ taskId: "task-interrupted", state: "interrupted", reviewReason: "interrupted" }),
			active: null,
			replayOutputHistory: [Buffer.from("previous output", "utf8")],
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(
			manager as unknown as {
				entries: Map<string, typeof entry>;
			}
		).entries.set("task-interrupted", entry);

		manager.attach("task-interrupted", {
			onOutput,
		});

		expect(onOutput).toHaveBeenCalledTimes(1);
		expect((onOutput.mock.calls[0]?.[0] as Buffer).toString("utf8")).toBe("previous output");
	});

	it("auto-approves supervised read-only permission prompts", () => {
		vi.useFakeTimers();
		const manager = new TerminalSessionManager();
		const writeSpy = vi.fn();
		(
			manager as unknown as {
				entries: Map<
					string,
					{
						summary: RuntimeTaskSessionSummary;
						active: {
							session: { write: (input: string) => void };
							approvalMode: "supervised";
							supervisedApprovalTimer: NodeJS.Timeout | null;
							lastSupervisedApprovalFingerprint: string | null;
						};
						replayOutputHistory: Buffer[];
						listenerIdCounter: number;
						listeners: Map<number, unknown>;
						restartRequest: null;
						suppressAutoRestartOnExit: boolean;
						autoRestartTimestamps: number[];
						pendingAutoRestart: null;
					}
				>;
			}
		).entries.set("task-1", {
			summary: createSummary({
				state: "awaiting_review",
				reviewReason: "hook",
				agentId: "codex",
				latestHookActivity: {
					activityText: "Waiting for approval",
					toolName: "Read",
					toolInputSummary: "src/index.ts",
					finalMessage: null,
					hookEventName: "approval_request",
					notificationType: "permission_prompt",
					source: "codex",
				},
			}),
			active: {
				session: { write: writeSpy },
				approvalMode: "supervised",
				supervisedApprovalTimer: null,
				lastSupervisedApprovalFingerprint: null,
			},
			replayOutputHistory: [],
			listenerIdCounter: 1,
			listeners: new Map(),
			restartRequest: null,
			suppressAutoRestartOnExit: false,
			autoRestartTimestamps: [],
			pendingAutoRestart: null,
		});

		expect(manager.maybeAutoApprovePendingPrompt("task-1")).toBe(true);
		vi.advanceTimersByTime(300);

		expect(writeSpy).toHaveBeenCalledWith("\r");
	});

	it("does not auto-approve unsafe supervised permission prompts", () => {
		const manager = new TerminalSessionManager();
		const writeSpy = vi.fn();
		(
			manager as unknown as {
				entries: Map<
					string,
					{
						summary: RuntimeTaskSessionSummary;
						active: {
							session: { write: (input: string) => void };
							approvalMode: "supervised";
							supervisedApprovalTimer: NodeJS.Timeout | null;
							lastSupervisedApprovalFingerprint: string | null;
						};
						replayOutputHistory: Buffer[];
						listenerIdCounter: number;
						listeners: Map<number, unknown>;
						restartRequest: null;
						suppressAutoRestartOnExit: boolean;
						autoRestartTimestamps: number[];
						pendingAutoRestart: null;
					}
				>;
			}
		).entries.set("task-1", {
			summary: createSummary({
				state: "awaiting_review",
				reviewReason: "hook",
				latestHookActivity: {
					activityText: "Waiting for approval",
					toolName: "Bash",
					toolInputSummary: "rm -rf dist",
					finalMessage: null,
					hookEventName: "approval_request",
					notificationType: "permission_prompt",
					source: "codex",
				},
			}),
			active: {
				session: { write: writeSpy },
				approvalMode: "supervised",
				supervisedApprovalTimer: null,
				lastSupervisedApprovalFingerprint: null,
			},
			replayOutputHistory: [],
			listenerIdCounter: 1,
			listeners: new Map(),
			restartRequest: null,
			suppressAutoRestartOnExit: false,
			autoRestartTimestamps: [],
			pendingAutoRestart: null,
		});

		expect(manager.maybeAutoApprovePendingPrompt("task-1")).toBe(false);
		expect(writeSpy).not.toHaveBeenCalled();
	});
});
