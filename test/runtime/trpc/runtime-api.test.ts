import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RuntimeConfigState } from "../../../src/config/runtime-config.js";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract.js";

const agentRegistryMocks = vi.hoisted(() => ({
	resolveAgentCommand: vi.fn(),
}));

const taskWorktreeMocks = vi.hoisted(() => ({
	resolveTaskCwd: vi.fn(),
}));

const turnCheckpointMocks = vi.hoisted(() => ({
	captureTaskTurnCheckpoint: vi.fn(),
}));

vi.mock("../../../src/terminal/agent-registry.js", () => ({
	resolveAgentCommand: agentRegistryMocks.resolveAgentCommand,
}));

vi.mock("../../../src/workspace/task-worktree.js", () => ({
	resolveTaskCwd: taskWorktreeMocks.resolveTaskCwd,
}));

vi.mock("../../../src/workspace/turn-checkpoints.js", () => ({
	captureTaskTurnCheckpoint: turnCheckpointMocks.captureTaskTurnCheckpoint,
}));

import { createRuntimeApi } from "../../../src/trpc/runtime-api.js";

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "codex",
		workspacePath: "/tmp/worktree",
		pid: 1234,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: Date.now(),
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...overrides,
	};
}

function createRuntimeConfigState(): RuntimeConfigState {
	return {
		selectedAgentId: "codex",
		selectedShortcutLabel: null,
		agentAutonomousModeEnabled: true,
		readyForReviewNotificationsEnabled: true,
		shortcuts: [],
		commitPromptTemplate: "commit",
		openPrPromptTemplate: "pr",
		commitPromptTemplateDefault: "commit",
		openPrPromptTemplateDefault: "pr",
		globalConfigPath: "/tmp/global-config.json",
		projectConfigPath: "/tmp/project-config.json",
	};
}

function createTaskSessionServiceMock() {
	return {
		startTaskSession: vi.fn<(...args: unknown[]) => Promise<RuntimeTaskSessionSummary>>(async () =>
			createSummary({ agentId: "cline", pid: null }),
		),
		onMessage: vi.fn<(...args: unknown[]) => () => void>(() => () => {}),
		stopTaskSession: vi.fn<(...args: unknown[]) => Promise<RuntimeTaskSessionSummary | null>>(async () => null),
		abortTaskSession: vi.fn<(...args: unknown[]) => Promise<RuntimeTaskSessionSummary | null>>(async () => null),
		cancelTaskTurn: vi.fn<(...args: unknown[]) => Promise<RuntimeTaskSessionSummary | null>>(async () => null),
		sendTaskSessionInput: vi.fn<(...args: unknown[]) => Promise<RuntimeTaskSessionSummary | null>>(async () => null),
		reloadTaskSession: vi.fn<(...args: unknown[]) => Promise<RuntimeTaskSessionSummary | null>>(async () => null),
		rebindPersistedTaskSession: vi.fn<(...args: unknown[]) => Promise<RuntimeTaskSessionSummary | null>>(
			async () => null,
		),
		getSummary: vi.fn<(...args: unknown[]) => RuntimeTaskSessionSummary | null>(() => null),
		listSummaries: vi.fn<(...args: unknown[]) => RuntimeTaskSessionSummary[]>(() => []),
		listMessages: vi.fn<(...args: unknown[]) => unknown[]>(() => []),
		loadTaskSessionMessages: vi.fn<(...args: unknown[]) => Promise<unknown[]>>(async () => []),
		applyTurnCheckpoint: vi.fn<(...args: unknown[]) => RuntimeTaskSessionSummary | null>(() => null),
		dispose: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
	};
}

describe("createRuntimeApi runtime behavior", () => {
	beforeEach(() => {
		agentRegistryMocks.resolveAgentCommand.mockReset();
		taskWorktreeMocks.resolveTaskCwd.mockReset();
		turnCheckpointMocks.captureTaskTurnCheckpoint.mockReset();

		agentRegistryMocks.resolveAgentCommand.mockReturnValue({
			agentId: "codex",
			label: "OpenAI Codex",
			command: "codex",
			binary: "codex",
			args: [],
		});
		turnCheckpointMocks.captureTaskTurnCheckpoint.mockResolvedValue({
			turn: 1,
			ref: "refs/kanban/checkpoints/task-1/turn/1",
			commit: "1111111",
			createdAt: Date.now(),
		});
	});

	it("reuses an existing worktree path before falling back to ensure", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");

		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary()),
			applyTurnCheckpoint: vi.fn(),
		};
		const taskSessionService = createTaskSessionServiceMock();
		const api = createRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedTaskSessionService: vi.fn(async () => taskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.startTaskSession(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				prompt: "Investigate startup freeze",
			},
		);

		expect(response.ok).toBe(true);
		expect(taskWorktreeMocks.resolveTaskCwd).toHaveBeenCalledTimes(1);
		expect(taskWorktreeMocks.resolveTaskCwd).toHaveBeenCalledWith({
			cwd: "/tmp/repo",
			taskId: "task-1",
			baseRef: "main",
			ensure: false,
		});
		expect(terminalManager.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: "/tmp/existing-worktree",
			}),
		);
	});

	it("ensures the worktree when no existing task cwd is available", async () => {
		taskWorktreeMocks.resolveTaskCwd
			.mockRejectedValueOnce(new Error("missing"))
			.mockResolvedValueOnce("/tmp/new-worktree");

		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary()),
			applyTurnCheckpoint: vi.fn(),
		};
		const taskSessionService = createTaskSessionServiceMock();
		const api = createRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
		getScopedTaskSessionService: vi.fn(async () => taskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.startTaskSession(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				prompt: "Investigate startup freeze",
			},
		);

		expect(response.ok).toBe(true);
		expect(taskWorktreeMocks.resolveTaskCwd).toHaveBeenNthCalledWith(1, {
			cwd: "/tmp/repo",
			taskId: "task-1",
			baseRef: "main",
			ensure: false,
		});
		expect(taskWorktreeMocks.resolveTaskCwd).toHaveBeenNthCalledWith(2, {
			cwd: "/tmp/repo",
			taskId: "task-1",
			baseRef: "main",
			ensure: true,
		});
	});

	it("fails fast when a legacy cline selection is loaded from config", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");

		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary()),
			applyTurnCheckpoint: vi.fn(),
		};
		const taskSessionService = createTaskSessionServiceMock();

		const api = createRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => {
				const runtimeConfigState = createRuntimeConfigState();
				runtimeConfigState.selectedAgentId = "cline";
				return runtimeConfigState;
			}),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
		getScopedTaskSessionService: vi.fn(async () => taskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.startTaskSession(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				prompt: "Continue task",
				images: [
					{
						id: "img-1",
						data: "abc123",
						mimeType: "image/png",
					},
				],
				startInPlanMode: true,
			},
		);

		expect(response.ok).toBe(false);
		expect(response.summary).toBeNull();
		expect(response.error).toContain("Native agent support has been removed from FS Kanban");
		expect(taskWorktreeMocks.resolveTaskCwd).toHaveBeenCalledWith({
			cwd: "/tmp/repo",
			taskId: "task-1",
			baseRef: "main",
			ensure: false,
		});
		expect(terminalManager.startTaskSession).not.toHaveBeenCalled();
		expect(taskSessionService.startTaskSession).not.toHaveBeenCalled();
	});

	it("starts home agent sessions in the workspace root without resolving a task worktree", async () => {
		const homeTaskId = "__home_agent__:workspace-1:codex:abc123";
		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary({ taskId: homeTaskId })),
			applyTurnCheckpoint: vi.fn(),
		};
		const taskSessionService = createTaskSessionServiceMock();
		const api = createRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
		getScopedTaskSessionService: vi.fn(async () => taskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.startTaskSession(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: homeTaskId,
				baseRef: "main",
				prompt: "",
			},
		);

		expect(response.ok).toBe(true);
		expect(taskWorktreeMocks.resolveTaskCwd).not.toHaveBeenCalled();
		expect(terminalManager.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				taskId: homeTaskId,
				cwd: "/tmp/repo",
			}),
		);
		expect(turnCheckpointMocks.captureTaskTurnCheckpoint).not.toHaveBeenCalled();
	});

	it("forwards task images to CLI task sessions", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		agentRegistryMocks.resolveAgentCommand.mockReturnValue({
			agentId: "codex",
			label: "OpenAI Codex",
			command: "codex",
			binary: "codex",
			args: [],
		});

		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary({ agentId: "codex" })),
			applyTurnCheckpoint: vi.fn(),
		};
		const taskSessionService = createTaskSessionServiceMock();
		const api = createRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => {
				const runtimeConfigState = createRuntimeConfigState();
				runtimeConfigState.selectedAgentId = "codex";
				return runtimeConfigState;
			}),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedTaskSessionService: vi.fn(async () => taskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const images = [
			{
				id: "img-1",
				data: Buffer.from("hello").toString("base64"),
				mimeType: "image/png",
				name: "diagram.png",
			},
		];

		const response = await api.startTaskSession(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				prompt: "Continue task",
				images,
			},
		);

		expect(response.ok).toBe(true);
		expect(terminalManager.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "codex",
				images,
			}),
		);
		expect(taskSessionService.startTaskSession).not.toHaveBeenCalled();
	});

	it("hydrates persisted chat messages when no live in-memory session is loaded", async () => {
		const persistedMessage = {
			id: "message-persisted-1",
			role: "assistant" as const,
			content: "Recovered from SDK artifacts",
			createdAt: Date.now(),
		};
		const taskSessionService = createTaskSessionServiceMock();
		taskSessionService.getSummary.mockReturnValue(null);
		taskSessionService.loadTaskSessionMessages.mockResolvedValue([persistedMessage]);

		const api = createRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
		getScopedTaskSessionService: vi.fn(async () => taskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.getTaskChatMessages(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-1" },
		);

		expect(response.ok).toBe(true);
		expect(response.messages).toEqual([persistedMessage]);
		expect(taskSessionService.loadTaskSessionMessages).toHaveBeenCalledWith("task-1");
	});

	it("reloads a chat session through the task session service", async () => {
		const summary = createSummary({ agentId: "cline", pid: null });
		const taskSessionService = createTaskSessionServiceMock();
		taskSessionService.reloadTaskSession.mockResolvedValue(summary);

		const api = createRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
		getScopedTaskSessionService: vi.fn(async () => taskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.reloadTaskChatSession(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "__home_agent__:workspace-1:cline" },
		);

		expect(response).toEqual({
			ok: true,
			summary,
		});
		expect(taskSessionService.reloadTaskSession).toHaveBeenCalledWith("__home_agent__:workspace-1:cline");
	});

	it("rebinds persisted non-home chat sessions before retrying the first send after restart", async () => {
		const summary = createSummary({ agentId: "cline", pid: null });
		const latestMessage = {
			id: "message-rebound-1",
			role: "user" as const,
			content: "continue",
			createdAt: Date.now(),
		};
		const taskSessionService = createTaskSessionServiceMock();
		taskSessionService.sendTaskSessionInput.mockResolvedValueOnce(null).mockResolvedValueOnce(summary);
		taskSessionService.rebindPersistedTaskSession.mockResolvedValue(summary);
		taskSessionService.listMessages.mockReturnValue([latestMessage]);

		const api = createRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
		getScopedTaskSessionService: vi.fn(async () => taskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.sendTaskChatMessage(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-1", text: "continue" },
		);

		expect(response.ok).toBe(true);
		expect(taskSessionService.rebindPersistedTaskSession).toHaveBeenCalledWith("task-1");
		expect(taskSessionService.sendTaskSessionInput).toHaveBeenNthCalledWith(1, "task-1", "continue", undefined, undefined);
		expect(taskSessionService.sendTaskSessionInput).toHaveBeenNthCalledWith(2, "task-1", "continue", undefined, undefined);
		expect(response.message).toEqual(latestMessage);
	});

	it("allows kanban by default for non-cline providers", async () => {
		const api = createRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
		getScopedTaskSessionService: vi.fn(async () => createTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.getKanbanAccess({
			workspaceId: "workspace-1",
			workspacePath: "/tmp/repo",
		});

		expect(response.enabled).toBe(true);
	});

	it("runs reset teardown before deleting debug state paths", async () => {
		const originalHome = process.env.HOME;
		const tempHome = `/tmp/kanban-reset-home-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		process.env.HOME = tempHome;
		mkdirSync(tempHome, { recursive: true });
		const debugPaths = [
			join(tempHome, ".config", "fs-kanban"),
			join(tempHome, ".config", "fs-kanban", "worktrees"),
			join(tempHome, ".config", "fs-kanban", "data"),
		];
		for (const path of debugPaths) {
			mkdirSync(path, { recursive: true });
			writeFileSync(join(path, "marker.txt"), "present");
		}
		const prepareForStateReset = vi.fn(async () => {
			for (const path of debugPaths) {
				expect(existsSync(path)).toBe(true);
			}
		});
		const api = createRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
		getScopedTaskSessionService: vi.fn(async () => createTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
			prepareForStateReset,
		});

		try {
			const response = await api.resetAllState(null);

			expect(response.ok).toBe(true);
			expect(prepareForStateReset).toHaveBeenCalledTimes(1);
			for (const path of debugPaths) {
				expect(existsSync(path)).toBe(false);
			}
		} finally {
			if (originalHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = originalHome;
			}
			rmSync(tempHome, { recursive: true, force: true });
		}
	});

	it("aborts reset path deletion when teardown fails", async () => {
		const originalHome = process.env.HOME;
		const tempHome = `/tmp/kanban-reset-home-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		process.env.HOME = tempHome;
		mkdirSync(tempHome, { recursive: true });
		const debugPaths = [
			join(tempHome, ".config", "fs-kanban"),
			join(tempHome, ".config", "fs-kanban", "worktrees"),
			join(tempHome, ".config", "fs-kanban", "data"),
		];
		for (const path of debugPaths) {
			mkdirSync(path, { recursive: true });
			writeFileSync(join(path, "marker.txt"), "present");
		}
		const api = createRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
		getScopedTaskSessionService: vi.fn(async () => createTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
			prepareForStateReset: vi.fn(async () => {
				throw new Error("teardown failed");
			}),
		});

		try {
			await expect(api.resetAllState(null)).rejects.toThrow("teardown failed");
			for (const path of debugPaths) {
				expect(existsSync(path)).toBe(true);
			}
		} finally {
			if (originalHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = originalHome;
			}
			rmSync(tempHome, { recursive: true, force: true });
		}
	});
});
