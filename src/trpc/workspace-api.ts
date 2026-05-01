import { TRPCError } from "@trpc/server";

import type {
	RuntimeBoardData,
	RuntimeGitCheckoutResponse,
	RuntimeGitDiscardResponse,
	RuntimeGitSummaryResponse,
	RuntimeGitSyncAction,
	RuntimeGitSyncResponse,
	RuntimeWorkspaceChangesMode,
	RuntimeWorkspaceFileSearchResponse,
	RuntimeWorkspaceImportBacklogTaskResult,
	RuntimeWorkspaceImportBacklogTasksResponse,
	RuntimeWorkspaceImportedTaskLookupResponse,
	RuntimeWorkspaceStateResponse,
} from "../core/api-contract.js";
import {
	parseGitCheckoutRequest,
	parseWorktreeDeleteRequest,
	parseWorktreeEnsureRequest,
} from "../core/api-validation.js";
import { findTaskByExternalSource, upsertBacklogTaskByExternalSource } from "../core/task-board-mutations.js";
import {
	getWorkspaceJournalDir,
	saveWorkspaceStateById,
	WorkspaceStateConflictError,
} from "../state/workspace-state.js";
import { OutputJournal } from "../terminal/output-journal.js";
import type { TerminalSessionManager } from "../terminal/session-manager.js";
import {
	createEmptyWorkspaceChangesResponse,
	getWorkspaceChanges,
	getWorkspaceChangesBetweenRefs,
	getWorkspaceChangesFromRef,
} from "../workspace/get-workspace-changes.js";
import { getCommitDiff, getGitLog, getGitRefs } from "../workspace/git-history.js";
import { discardGitChanges, getGitSyncSummary, runGitCheckoutAction, runGitSyncAction } from "../workspace/git-sync.js";
import { searchWorkspaceFiles } from "../workspace/search-workspace-files.js";
import {
	deleteTaskWorktree,
	ensureTaskWorktreeIfDoesntExist,
	getTaskWorkspaceInfo,
	resolveTaskCwd,
} from "../workspace/task-worktree.js";
import type { RuntimeTrpcContext } from "./app-router.js";

export interface CreateWorkspaceApiDependencies {
	ensureTerminalManagerForWorkspace: (workspaceId: string, repoPath: string) => Promise<TerminalSessionManager>;
	broadcastRuntimeWorkspaceStateUpdated: (workspaceId: string, workspacePath: string) => Promise<void> | void;
	broadcastRuntimeProjectsUpdated: (preferredCurrentProjectId: string | null) => Promise<void> | void;
	buildWorkspaceStateSnapshot: (workspaceId: string, workspacePath: string) => Promise<RuntimeWorkspaceStateResponse>;
}

function normalizeOptionalTaskWorkspaceScopeInput(
	input: { taskId: string; baseRef: string } | null,
): { taskId: string; baseRef: string } | null {
	if (!input) {
		return null;
	}
	const taskId = input.taskId.trim();
	const baseRef = input.baseRef.trim();
	if (!taskId || !baseRef) {
		throw new Error("baseRef query parameter requires taskId.");
	}
	return {
		taskId,
		baseRef,
	};
}

function normalizeRequiredTaskWorkspaceScopeInput(input: {
	taskId: string;
	baseRef: string;
	mode?: RuntimeWorkspaceChangesMode;
}): {
	taskId: string;
	baseRef: string;
	mode: RuntimeWorkspaceChangesMode;
} {
	const taskId = input.taskId.trim();
	const baseRef = input.baseRef.trim();
	if (!taskId) {
		throw new Error("Missing taskId query parameter.");
	}
	if (!baseRef) {
		throw new Error("Missing baseRef query parameter.");
	}
	const mode: RuntimeWorkspaceChangesMode = input.mode ?? "working_copy";
	return {
		taskId,
		baseRef,
		mode,
	};
}

function createEmptyGitSummaryErrorResponse(error: unknown): RuntimeGitSummaryResponse {
	const message = error instanceof Error ? error.message : String(error);
	return {
		ok: false,
		summary: {
			currentBranch: null,
			upstreamBranch: null,
			changedFiles: 0,
			additions: 0,
			deletions: 0,
			aheadCount: 0,
			behindCount: 0,
		},
		error: message,
	};
}

function createEmptyGitSyncErrorResponse(action: RuntimeGitSyncAction, error: unknown): RuntimeGitSyncResponse {
	const message = error instanceof Error ? error.message : String(error);
	return {
		ok: false,
		action,
		summary: {
			currentBranch: null,
			upstreamBranch: null,
			changedFiles: 0,
			additions: 0,
			deletions: 0,
			aheadCount: 0,
			behindCount: 0,
		},
		output: "",
		error: message,
	};
}

function createEmptyGitCheckoutErrorResponse(error: unknown): RuntimeGitCheckoutResponse {
	const message = error instanceof Error ? error.message : String(error);
	return {
		ok: false,
		branch: "",
		summary: {
			currentBranch: null,
			upstreamBranch: null,
			changedFiles: 0,
			additions: 0,
			deletions: 0,
			aheadCount: 0,
			behindCount: 0,
		},
		output: "",
		error: message,
	};
}

function createEmptyGitDiscardErrorResponse(error: unknown): RuntimeGitDiscardResponse {
	const message = error instanceof Error ? error.message : String(error);
	return {
		ok: false,
		summary: {
			currentBranch: null,
			upstreamBranch: null,
			changedFiles: 0,
			additions: 0,
			deletions: 0,
			aheadCount: 0,
			behindCount: 0,
		},
		output: "",
		error: message,
	};
}

function resolveDefaultBaseRef(workspaceState: RuntimeWorkspaceStateResponse): string {
	return (
		workspaceState.git.currentBranch ?? workspaceState.git.defaultBranch ?? workspaceState.git.branches[0] ?? "main"
	);
}

function mergeLiveTaskSessions(
	sessions: RuntimeWorkspaceStateResponse["sessions"],
	terminalManager: TerminalSessionManager,
): RuntimeWorkspaceStateResponse["sessions"] {
	const nextSessions = {
		...sessions,
	};
	for (const summary of terminalManager.listSummaries()) {
		nextSessions[summary.taskId] = summary;
	}
	return nextSessions;
}

function summarizeImportResults(
	results: RuntimeWorkspaceImportBacklogTaskResult[],
): RuntimeWorkspaceImportBacklogTasksResponse {
	let created = 0;
	let updated = 0;
	let unchanged = 0;
	let skipped = 0;
	for (const result of results) {
		if (result.status === "created") {
			created += 1;
			continue;
		}
		if (result.status === "updated") {
			updated += 1;
			continue;
		}
		if (result.status === "skipped") {
			skipped += 1;
			continue;
		}
		unchanged += 1;
	}
	return {
		created,
		updated,
		unchanged,
		skipped,
		results,
	};
}

export function createWorkspaceApi(deps: CreateWorkspaceApiDependencies): RuntimeTrpcContext["workspaceApi"] {
	return {
		loadGitSummary: async (workspaceScope, input) => {
			try {
				const taskScope = normalizeOptionalTaskWorkspaceScopeInput(input);
				let summaryCwd = workspaceScope.workspacePath;
				if (taskScope) {
					summaryCwd = await resolveTaskCwd({
						cwd: workspaceScope.workspacePath,
						taskId: taskScope.taskId,
						baseRef: taskScope.baseRef,
						ensure: false,
					});
				}
				const summary = await getGitSyncSummary(summaryCwd);
				return {
					ok: true,
					summary,
				} satisfies RuntimeGitSummaryResponse;
			} catch (error) {
				return createEmptyGitSummaryErrorResponse(error);
			}
		},
		runGitSyncAction: async (workspaceScope, input) => {
			try {
				return await runGitSyncAction({
					cwd: workspaceScope.workspacePath,
					action: input.action,
				});
			} catch (error) {
				return createEmptyGitSyncErrorResponse(input.action, error);
			}
		},
		checkoutGitBranch: async (workspaceScope, input) => {
			try {
				const body = parseGitCheckoutRequest(input);
				const response = await runGitCheckoutAction({
					cwd: workspaceScope.workspacePath,
					branch: body.branch,
				});
				if (response.ok) {
					void deps.broadcastRuntimeWorkspaceStateUpdated(
						workspaceScope.workspaceId,
						workspaceScope.workspacePath,
					);
				}
				return response;
			} catch (error) {
				return createEmptyGitCheckoutErrorResponse(error);
			}
		},
		discardGitChanges: async (workspaceScope, input) => {
			try {
				const taskScope = normalizeOptionalTaskWorkspaceScopeInput(input);
				let discardCwd = workspaceScope.workspacePath;
				if (taskScope) {
					discardCwd = await resolveTaskCwd({
						cwd: workspaceScope.workspacePath,
						taskId: taskScope.taskId,
						baseRef: taskScope.baseRef,
						ensure: false,
					});
				}
				const response = await discardGitChanges({
					cwd: discardCwd,
				});
				if (response.ok) {
					void deps.broadcastRuntimeWorkspaceStateUpdated(
						workspaceScope.workspaceId,
						workspaceScope.workspacePath,
					);
				}
				return response;
			} catch (error) {
				return createEmptyGitDiscardErrorResponse(error);
			}
		},
		loadChanges: async (workspaceScope, input) => {
			const normalizedInput = normalizeRequiredTaskWorkspaceScopeInput(input);
			const taskCwd = await resolveTaskCwd({
				cwd: workspaceScope.workspacePath,
				taskId: normalizedInput.taskId,
				baseRef: normalizedInput.baseRef,
				ensure: false,
			});
			if (normalizedInput.mode === "last_turn") {
				const terminalManager = await deps.ensureTerminalManagerForWorkspace(
					workspaceScope.workspaceId,
					workspaceScope.workspacePath,
				);
				const summary = terminalManager.getSummary(normalizedInput.taskId);
				const fromCheckpoint = summary?.previousTurnCheckpoint;
				const toCheckpoint = summary?.latestTurnCheckpoint;
				if (!toCheckpoint) {
					return await createEmptyWorkspaceChangesResponse(taskCwd);
				}
				if (summary?.state === "running" || !fromCheckpoint) {
					return await getWorkspaceChangesFromRef({
						cwd: taskCwd,
						fromRef: toCheckpoint.commit,
					});
				}
				return await getWorkspaceChangesBetweenRefs({
					cwd: taskCwd,
					fromRef: fromCheckpoint.commit,
					toRef: toCheckpoint.commit,
				});
			}
			return await getWorkspaceChanges(taskCwd);
		},
		ensureWorktree: async (workspaceScope, input) => {
			const body = parseWorktreeEnsureRequest(input);
			return await ensureTaskWorktreeIfDoesntExist({
				cwd: workspaceScope.workspacePath,
				taskId: body.taskId,
				baseRef: body.baseRef,
			});
		},
		deleteWorktree: async (workspaceScope, input) => {
			const body = parseWorktreeDeleteRequest(input);
			const result = await deleteTaskWorktree({
				repoPath: workspaceScope.workspacePath,
				taskId: body.taskId,
			});
			if (result.ok && body.preserveJournal === false) {
				await OutputJournal.deleteForTask({
					dir: getWorkspaceJournalDir(workspaceScope.workspaceId),
					taskId: body.taskId,
				});
			}
			return result;
		},
		loadTaskContext: async (workspaceScope, input) => {
			const normalizedInput = normalizeRequiredTaskWorkspaceScopeInput(input);
			return await getTaskWorkspaceInfo({
				cwd: workspaceScope.workspacePath,
				taskId: normalizedInput.taskId,
				baseRef: normalizedInput.baseRef,
			});
		},
		searchFiles: async (workspaceScope, input) => {
			const query = input.query.trim();
			const limit = input.limit;
			const files = await searchWorkspaceFiles(workspaceScope.workspacePath, query, limit);
			return {
				query,
				files,
			} satisfies RuntimeWorkspaceFileSearchResponse;
		},
		loadState: async (workspaceScope) => {
			return await deps.buildWorkspaceStateSnapshot(workspaceScope.workspaceId, workspaceScope.workspacePath);
		},
		notifyStateUpdated: async (workspaceScope) => {
			void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceScope.workspaceId, workspaceScope.workspacePath);
			void deps.broadcastRuntimeProjectsUpdated(workspaceScope.workspaceId);
			return {
				ok: true,
			};
		},
		saveState: async (workspaceScope, input) => {
			try {
				const terminalManager = await deps.ensureTerminalManagerForWorkspace(
					workspaceScope.workspaceId,
					workspaceScope.workspacePath,
				);
				input.sessions = mergeLiveTaskSessions(input.sessions, terminalManager);
				const response = await saveWorkspaceStateById(
					workspaceScope.workspaceId,
					workspaceScope.workspacePath,
					input,
				);
				void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceScope.workspaceId, workspaceScope.workspacePath);
				void deps.broadcastRuntimeProjectsUpdated(workspaceScope.workspaceId);
				return response;
			} catch (error) {
				if (error instanceof WorkspaceStateConflictError) {
					throw new TRPCError({
						code: "CONFLICT",
						message: error.message,
						cause: {
							currentRevision: error.currentRevision,
						},
					});
				}
				throw error;
			}
		},
		importBacklogTasks: async (workspaceScope, input) => {
			try {
				const workspaceState = await deps.buildWorkspaceStateSnapshot(
					workspaceScope.workspaceId,
					workspaceScope.workspacePath,
				);
				const defaultBaseRef = resolveDefaultBaseRef(workspaceState);
				let nextBoard: RuntimeBoardData = workspaceState.board;
				const results: RuntimeWorkspaceImportBacklogTaskResult[] = [];
				for (const item of input.items) {
					const imported = upsertBacklogTaskByExternalSource(
						nextBoard,
						{
							prompt: item.prompt,
							baseRef: item.baseRef?.trim() || defaultBaseRef,
							startInPlanMode: item.startInPlanMode,
							autoReviewEnabled: item.autoReviewEnabled,
							autoReviewMode: item.autoReviewMode,
							externalSource: item.externalSource,
						},
						() => crypto.randomUUID(),
					);
					nextBoard = imported.board;
					results.push({
						taskId: imported.task.id,
						externalId: item.externalSource.externalId,
						status: imported.status,
						columnId: imported.columnId,
						reason: imported.reason,
					});
				}
				const summary = summarizeImportResults(results);
				if (summary.created === 0 && summary.updated === 0) {
					return summary;
				}
				const terminalManager = await deps.ensureTerminalManagerForWorkspace(
					workspaceScope.workspaceId,
					workspaceScope.workspacePath,
				);
				await saveWorkspaceStateById(workspaceScope.workspaceId, workspaceScope.workspacePath, {
					board: nextBoard,
					sessions: mergeLiveTaskSessions(workspaceState.sessions, terminalManager),
					expectedRevision: workspaceState.revision,
				});
				void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceScope.workspaceId, workspaceScope.workspacePath);
				void deps.broadcastRuntimeProjectsUpdated(workspaceScope.workspaceId);
				return summary;
			} catch (error) {
				if (error instanceof WorkspaceStateConflictError) {
					throw new TRPCError({
						code: "CONFLICT",
						message: error.message,
						cause: {
							currentRevision: error.currentRevision,
						},
					});
				}
				throw error;
			}
		},
		getImportedTaskByExternalSource: async (workspaceScope, input) => {
			const workspaceState = await deps.buildWorkspaceStateSnapshot(
				workspaceScope.workspaceId,
				workspaceScope.workspacePath,
			);
			const found = findTaskByExternalSource(workspaceState.board, input.externalSource);
			if (!found) {
				return {
					found: false,
					taskId: null,
					columnId: null,
					task: null,
				} satisfies RuntimeWorkspaceImportedTaskLookupResponse;
			}
			return {
				found: true,
				taskId: found.task.id,
				columnId: found.columnId,
				task: found.task,
			} satisfies RuntimeWorkspaceImportedTaskLookupResponse;
		},
		loadWorkspaceChanges: async (workspaceScope) => {
			return await getWorkspaceChanges(workspaceScope.workspacePath);
		},
		loadGitLog: async (workspaceScope, input) => {
			const taskScope = normalizeOptionalTaskWorkspaceScopeInput(input.taskScope ?? null);
			let logCwd = workspaceScope.workspacePath;
			if (taskScope) {
				logCwd = await resolveTaskCwd({
					cwd: workspaceScope.workspacePath,
					taskId: taskScope.taskId,
					baseRef: taskScope.baseRef,
					ensure: false,
				});
			}
			return await getGitLog({
				cwd: logCwd,
				ref: input.ref ?? null,
				refs: input.refs ?? null,
				maxCount: input.maxCount,
				skip: input.skip,
			});
		},
		loadGitRefs: async (workspaceScope, input) => {
			const taskScope = normalizeOptionalTaskWorkspaceScopeInput(input ?? null);
			let refsCwd = workspaceScope.workspacePath;
			if (taskScope) {
				refsCwd = await resolveTaskCwd({
					cwd: workspaceScope.workspacePath,
					taskId: taskScope.taskId,
					baseRef: taskScope.baseRef,
					ensure: false,
				});
			}
			return await getGitRefs(refsCwd);
		},
		loadCommitDiff: async (workspaceScope, input) => {
			const taskScope = normalizeOptionalTaskWorkspaceScopeInput(input.taskScope ?? null);
			let diffCwd = workspaceScope.workspacePath;
			if (taskScope) {
				diffCwd = await resolveTaskCwd({
					cwd: workspaceScope.workspacePath,
					taskId: taskScope.taskId,
					baseRef: taskScope.baseRef,
					ensure: false,
				});
			}
			return await getCommitDiff({
				cwd: diffCwd,
				commitHash: input.commitHash,
			});
		},
	};
}
