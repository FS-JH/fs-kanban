import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import * as lockfile from "proper-lockfile";
import { describe, expect, it } from "vitest";

import type { RuntimeBoardData, RuntimeTaskSessionSummary } from "../../src/core/api-contract.js";
import { shutdownRuntimeServer } from "../../src/server/shutdown-coordinator.js";
import {
	getWorkspacesRootPath,
	loadWorkspaceContext,
	loadWorkspaceState,
	saveWorkspaceState,
} from "../../src/state/workspace-state.js";
import type { TerminalSessionManager } from "../../src/terminal/session-manager.js";
import { createGitTestEnv } from "../utilities/git-env.js";
import { createTempDir } from "../utilities/temp-dir.js";

async function withTemporaryHome<T>(run: () => Promise<T>): Promise<T> {
	const { path: tempHome, cleanup } = createTempDir("kanban-home-shutdown-");
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
	try {
		return await run();
	} finally {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		cleanup();
	}
}

function initGitRepository(path: string): void {
	const init = spawnSync("git", ["init"], {
		cwd: path,
		stdio: "ignore",
		env: createGitTestEnv(),
	});
	if (init.status !== 0) {
		throw new Error(`Failed to initialize git repository at ${path}`);
	}
}

function createCard(taskId: string) {
	return {
		id: taskId,
		prompt: `Task ${taskId}`,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

function createBoard(taskIds: { inProgress?: string[]; review?: string[] }): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{
				id: "in_progress",
				title: "In Progress",
				cards: (taskIds.inProgress ?? []).map((taskId) => createCard(taskId)),
			},
			{
				id: "review",
				title: "Review",
				cards: (taskIds.review ?? []).map((taskId) => createCard(taskId)),
			},
			{ id: "trash", title: "Trash", cards: [] },
		],
		dependencies: [],
	};
}

function createSession(taskId: string, state: "running" | "awaiting_review" | "idle"): RuntimeTaskSessionSummary {
	return {
		taskId,
		state,
		agentId: "codex",
		workspacePath: `/tmp/${taskId}`,
		pid: state === "idle" ? null : 1234,
		startedAt: state === "idle" ? null : Date.now() - 1_000,
		updatedAt: Date.now(),
		lastOutputAt: state === "idle" ? null : Date.now(),
		reviewReason: state === "awaiting_review" ? "hook" : null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
	};
}

describe.sequential("shutdown coordinator integration", () => {
	it(
		"preserves in-progress and review cards while marking sessions interrupted on shutdown",
		async () => {
			await withTemporaryHome(async () => {
				const { path: sandboxRoot, cleanup } = createTempDir("kanban-shutdown-scope-");
				try {
					const managedProjectPath = join(sandboxRoot, "managed-project");
					const indexedProjectPath = join(sandboxRoot, "indexed-project");
					mkdirSync(managedProjectPath, { recursive: true });
					mkdirSync(indexedProjectPath, { recursive: true });
					initGitRepository(managedProjectPath);
					initGitRepository(indexedProjectPath);

					const managedInitial = await loadWorkspaceState(managedProjectPath);
					await saveWorkspaceState(managedProjectPath, {
						board: createBoard({
							inProgress: ["managed-running", "managed-missing-session"],
							review: ["managed-idle"],
						}),
						sessions: {
							"managed-running": createSession("managed-running", "running"),
							"managed-idle": createSession("managed-idle", "idle"),
						},
						expectedRevision: managedInitial.revision,
					});

					const indexedInitial = await loadWorkspaceState(indexedProjectPath);
					await saveWorkspaceState(indexedProjectPath, {
						board: createBoard({
							inProgress: ["indexed-missing-session"],
							review: ["indexed-awaiting-review"],
						}),
						sessions: {
							"indexed-awaiting-review": createSession("indexed-awaiting-review", "awaiting_review"),
						},
						expectedRevision: indexedInitial.revision,
					});

					let didCloseRuntimeServer = false;
					const managedTerminalManager = {
						markInterruptedAndStopAll: () => [createSession("managed-running", "running")],
						listSummaries: () => [createSession("managed-running", "running")],
						getSummary: (taskId: string) => {
							if (taskId === "managed-running") {
								return createSession("managed-running", "running");
							}
							if (taskId === "managed-idle") {
								return createSession("managed-idle", "idle");
							}
							return null;
						},
					} as unknown as TerminalSessionManager;
					await shutdownRuntimeServer({
						workspaceRegistry: {
							listManagedWorkspaces: () => [
								{
									workspaceId: "managed-project",
									workspacePath: managedProjectPath,
									terminalManager: managedTerminalManager,
								},
							],
						},
						warn: () => {},
						closeRuntimeServer: async () => {
							didCloseRuntimeServer = true;
						},
					});

					expect(didCloseRuntimeServer).toBe(true);

					const managedAfter = await loadWorkspaceState(managedProjectPath);
					const managedInProgress =
						managedAfter.board.columns.find((column) => column.id === "in_progress")?.cards ?? [];
					const managedReview = managedAfter.board.columns.find((column) => column.id === "review")?.cards ?? [];
					const managedTrash = managedAfter.board.columns.find((column) => column.id === "trash")?.cards ?? [];
					expect(managedInProgress.map((card) => card.id).sort()).toEqual(
						["managed-missing-session", "managed-running"].sort(),
					);
					expect(managedReview.map((card) => card.id)).toEqual(["managed-idle"]);
					expect(managedTrash).toEqual([]);
					expect(managedAfter.sessions["managed-running"]?.state).toBe("interrupted");
					expect(managedAfter.sessions["managed-idle"]?.state).toBe("idle");
					expect(managedAfter.sessions["managed-missing-session"]).toBeUndefined();

					const indexedAfter = await loadWorkspaceState(indexedProjectPath);
					const indexedInProgress =
						indexedAfter.board.columns.find((column) => column.id === "in_progress")?.cards ?? [];
					const indexedReview = indexedAfter.board.columns.find((column) => column.id === "review")?.cards ?? [];
					const indexedTrash = indexedAfter.board.columns.find((column) => column.id === "trash")?.cards ?? [];
					expect(indexedInProgress.map((card) => card.id)).toEqual(["indexed-missing-session"]);
					expect(indexedReview.map((card) => card.id)).toEqual(["indexed-awaiting-review"]);
					expect(indexedTrash).toEqual([]);
					expect(indexedAfter.sessions["indexed-awaiting-review"]?.state).toBe("interrupted");
					expect(indexedAfter.sessions["indexed-missing-session"]).toBeUndefined();
				} finally {
					cleanup();
				}
			});
		},
		30_000,
	);

	it("completes shutdown cleanup even while the workspace index lock is held", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-shutdown-lock-bypass-");
			try {
				const managedProjectPath = join(sandboxRoot, "managed-project");
				const indexedProjectPath = join(sandboxRoot, "indexed-project");
				mkdirSync(managedProjectPath, { recursive: true });
				mkdirSync(indexedProjectPath, { recursive: true });
				initGitRepository(managedProjectPath);
				initGitRepository(indexedProjectPath);

				const managedInitial = await loadWorkspaceState(managedProjectPath);
				await saveWorkspaceState(managedProjectPath, {
					board: createBoard({
						inProgress: ["managed-running"],
					}),
					sessions: {
						"managed-running": createSession("managed-running", "running"),
					},
					expectedRevision: managedInitial.revision,
				});

				const indexedInitial = await loadWorkspaceState(indexedProjectPath);
				await saveWorkspaceState(indexedProjectPath, {
					board: createBoard({
						review: ["indexed-awaiting-review"],
					}),
					sessions: {
						"indexed-awaiting-review": createSession("indexed-awaiting-review", "awaiting_review"),
					},
					expectedRevision: indexedInitial.revision,
				});
				const managedContext = await loadWorkspaceContext(managedProjectPath);

				const indexPath = join(getWorkspacesRootPath(), "index.json");
				const release = await lockfile.lock(indexPath, {
					realpath: false,
					lockfilePath: `${indexPath}.lock`,
					stale: 10_000,
					retries: {
						retries: 0,
					},
				});

				try {
					let didCloseRuntimeServer = false;
					const managedTerminalManager = {
						markInterruptedAndStopAll: () => [createSession("managed-running", "running")],
						listSummaries: () => [createSession("managed-running", "running")],
						getSummary: (taskId: string) => {
							if (taskId === "managed-running") {
								return createSession("managed-running", "running");
							}
							return null;
						},
					} as unknown as TerminalSessionManager;

					const startedAt = Date.now();
					await shutdownRuntimeServer({
						workspaceRegistry: {
							listManagedWorkspaces: () => [
								{
									workspaceId: managedContext.workspaceId,
									workspacePath: managedProjectPath,
									terminalManager: managedTerminalManager,
								},
							],
						},
						warn: () => {},
						closeRuntimeServer: async () => {
							didCloseRuntimeServer = true;
						},
					});
					const elapsedMs = Date.now() - startedAt;

					expect(didCloseRuntimeServer).toBe(true);
					expect(elapsedMs).toBeLessThan(2_000);
				} finally {
					await release();
				}

				const managedAfter = await loadWorkspaceState(managedProjectPath);
				expect(managedAfter.sessions["managed-running"]?.state).toBe("interrupted");

				const indexedAfter = await loadWorkspaceState(indexedProjectPath);
				expect(indexedAfter.sessions["indexed-awaiting-review"]?.state).toBe("interrupted");
			} finally {
				cleanup();
			}
		});
	});
});
