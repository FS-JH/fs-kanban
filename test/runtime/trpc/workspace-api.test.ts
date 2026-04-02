import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
	RuntimeBoardData,
	RuntimeTaskSessionSummary,
	RuntimeWorkspaceChangesResponse,
	RuntimeWorkspaceStateResponse,
} from "../../../src/core/api-contract.js";
import { createWorkspaceApi } from "../../../src/trpc/workspace-api.js";

const workspaceTaskWorktreeMocks = vi.hoisted(() => ({
	resolveTaskCwd: vi.fn(),
}));

const workspaceChangesMocks = vi.hoisted(() => ({
	createEmptyWorkspaceChangesResponse: vi.fn(),
	getWorkspaceChanges: vi.fn(),
	getWorkspaceChangesBetweenRefs: vi.fn(),
	getWorkspaceChangesFromRef: vi.fn(),
}));

vi.mock("../../../src/workspace/task-worktree.js", () => ({
	deleteTaskWorktree: vi.fn(),
	ensureTaskWorktreeIfDoesntExist: vi.fn(),
	getTaskWorkspaceInfo: vi.fn(),
	resolveTaskCwd: workspaceTaskWorktreeMocks.resolveTaskCwd,
}));

vi.mock("../../../src/workspace/get-workspace-changes.js", () => ({
	createEmptyWorkspaceChangesResponse: workspaceChangesMocks.createEmptyWorkspaceChangesResponse,
	getWorkspaceChanges: workspaceChangesMocks.getWorkspaceChanges,
	getWorkspaceChangesBetweenRefs: workspaceChangesMocks.getWorkspaceChangesBetweenRefs,
	getWorkspaceChangesFromRef: workspaceChangesMocks.getWorkspaceChangesFromRef,
}));

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		mode: "act",
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
		warningMessage: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...overrides,
	};
}

function createChangesResponse(): RuntimeWorkspaceChangesResponse {
	return {
		repoRoot: "/tmp/worktree",
		generatedAt: Date.now(),
		files: [],
	};
}

function createWorkspaceState(board: RuntimeBoardData): RuntimeWorkspaceStateResponse {
	return {
		repoPath: "/tmp/repo",
		statePath: "/tmp/repo/.fs-kanban/state.json",
		git: {
			currentBranch: "main",
			defaultBranch: "main",
			branches: ["main"],
		},
		board,
		sessions: {},
		revision: 1,
	};
}

describe("createWorkspaceApi loadChanges", () => {
	beforeEach(() => {
		workspaceTaskWorktreeMocks.resolveTaskCwd.mockReset();
		workspaceChangesMocks.createEmptyWorkspaceChangesResponse.mockReset();
		workspaceChangesMocks.getWorkspaceChanges.mockReset();
		workspaceChangesMocks.getWorkspaceChangesBetweenRefs.mockReset();
		workspaceChangesMocks.getWorkspaceChangesFromRef.mockReset();

		workspaceTaskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/worktree");
		workspaceChangesMocks.createEmptyWorkspaceChangesResponse.mockResolvedValue(createChangesResponse());
		workspaceChangesMocks.getWorkspaceChanges.mockResolvedValue(createChangesResponse());
		workspaceChangesMocks.getWorkspaceChangesBetweenRefs.mockResolvedValue(createChangesResponse());
		workspaceChangesMocks.getWorkspaceChangesFromRef.mockResolvedValue(createChangesResponse());
	});

	it("shows the completed turn diff while awaiting review", async () => {
		const terminalManager = {
			getSummary: vi.fn(() =>
				createSummary({
					state: "awaiting_review",
					latestTurnCheckpoint: {
						turn: 2,
						ref: "refs/kanban/checkpoints/task-1/turn/2",
						commit: "2222222",
						createdAt: 2,
					},
					previousTurnCheckpoint: {
						turn: 1,
						ref: "refs/kanban/checkpoints/task-1/turn/1",
						commit: "1111111",
						createdAt: 1,
					},
				}),
			),
			listSummaries: vi.fn(() => []),
		};

		const api = createWorkspaceApi({
			ensureTerminalManagerForWorkspace: vi.fn(async () => terminalManager as never),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
		});

		await api.loadChanges(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-1", baseRef: "main", mode: "last_turn" },
		);

		expect(workspaceChangesMocks.getWorkspaceChangesBetweenRefs).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			fromRef: "1111111",
			toRef: "2222222",
		});
		expect(workspaceChangesMocks.getWorkspaceChangesFromRef).not.toHaveBeenCalled();
	});

	it("tracks the current turn from the latest checkpoint while running", async () => {
		const terminalManager = {
			getSummary: vi.fn(() =>
				createSummary({
					state: "running",
					latestTurnCheckpoint: {
						turn: 2,
						ref: "refs/kanban/checkpoints/task-1/turn/2",
						commit: "2222222",
						createdAt: 2,
					},
					previousTurnCheckpoint: {
						turn: 1,
						ref: "refs/kanban/checkpoints/task-1/turn/1",
						commit: "1111111",
						createdAt: 1,
					},
				}),
			),
			listSummaries: vi.fn(() => []),
		};

		const api = createWorkspaceApi({
			ensureTerminalManagerForWorkspace: vi.fn(async () => terminalManager as never),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
		});

		await api.loadChanges(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-1", baseRef: "main", mode: "last_turn" },
		);

		expect(workspaceChangesMocks.getWorkspaceChangesFromRef).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			fromRef: "2222222",
		});
		expect(workspaceChangesMocks.getWorkspaceChangesBetweenRefs).not.toHaveBeenCalled();
	});

	it("returns an empty last-turn diff when no terminal summary is available", async () => {
		const terminalManager = {
			getSummary: vi.fn(() => null),
			listSummaries: vi.fn(() => []),
		};

		const api = createWorkspaceApi({
			ensureTerminalManagerForWorkspace: vi.fn(async () => terminalManager as never),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
		});

		await api.loadChanges(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-1", baseRef: "main", mode: "last_turn" },
		);

		expect(workspaceChangesMocks.createEmptyWorkspaceChangesResponse).toHaveBeenCalledWith("/tmp/worktree");
		expect(workspaceChangesMocks.getWorkspaceChangesBetweenRefs).not.toHaveBeenCalled();
		expect(workspaceChangesMocks.getWorkspaceChangesFromRef).not.toHaveBeenCalled();
	});

	it("loads working copy changes when last-turn mode is not requested", async () => {
		const terminalManager = {
			getSummary: vi.fn(() => null),
			listSummaries: vi.fn(() => []),
		};

		const api = createWorkspaceApi({
			ensureTerminalManagerForWorkspace: vi.fn(async () => terminalManager as never),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
		});

		await api.loadChanges(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-1", baseRef: "main", mode: "working_copy" },
		);

		expect(workspaceChangesMocks.getWorkspaceChanges).toHaveBeenCalledWith("/tmp/worktree");
	});
});

describe("createWorkspaceApi imported task lookup", () => {
	it("returns the current column for a task imported from Notion", async () => {
		const workspaceState = createWorkspaceState({
			columns: [
				{
					id: "backlog",
					title: "Backlog",
					cards: [
						{
							id: "task-1",
							prompt: "Imported task",
							startInPlanMode: true,
							externalSource: {
								provider: "notion",
								externalId: "page-1",
								externalUrl: "https://notion.so/page-1",
								repoKey: "fs-kanban",
								itemType: "bug",
								sourceUpdatedAt: "2026-04-02T00:00:00.000Z",
								importedAt: 123,
							},
							baseRef: "main",
							createdAt: 1,
							updatedAt: 2,
						},
					],
				},
				{ id: "in_progress", title: "In Progress", cards: [] },
				{ id: "review", title: "Review", cards: [] },
				{ id: "trash", title: "Trash", cards: [] },
			],
			dependencies: [],
		});

		const api = createWorkspaceApi({
			ensureTerminalManagerForWorkspace: vi.fn(async () => ({ listSummaries: vi.fn(() => []) } as never)),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(async () => workspaceState),
		});

		const result = await api.getImportedTaskByExternalSource(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{
				externalSource: {
					provider: "notion",
					externalId: "page-1",
					externalUrl: "https://notion.so/page-1",
					repoKey: "fs-kanban",
					itemType: "bug",
					sourceUpdatedAt: "2026-04-02T00:00:00.000Z",
				},
			},
		);

		expect(result).toEqual({
			found: true,
			taskId: "task-1",
			columnId: "backlog",
			task: workspaceState.board.columns[0]?.cards[0],
		});
	});
});
