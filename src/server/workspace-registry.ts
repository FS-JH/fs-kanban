import { type RuntimeConfigState, toGlobalRuntimeConfigState } from "../config/runtime-config.js";
import type {
	RuntimeAggregateBoardCard,
	RuntimeAggregateBoardData,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeProjectSummary,
	RuntimeProjectTaskCounts,
	RuntimeTaskWorkspaceMetadata,
	RuntimeWorkspaceStateResponse,
} from "../core/api-contract.js";
import {
	getWorkspaceJournalDir,
	listWorkspaceIndexEntries,
	loadWorkspaceContext,
	loadWorkspaceSessionReplayHistoryById,
	loadWorkspaceStateById,
	type RuntimeWorkspaceIndexEntry,
	removeWorkspaceIndexEntry,
	removeWorkspaceStateFiles,
	saveWorkspaceTaskReplayHistoryById,
} from "../state/workspace-state.js";
import { OutputJournal } from "../terminal/output-journal.js";
import { TerminalSessionManager } from "../terminal/session-manager.js";
import type { SupervisorApprovalQueue } from "../terminal/supervisor-approval-queue.js";
import { getGitSyncSummary, probeGitWorkspaceState } from "../workspace/git-sync.js";
import { getTaskWorkspacePathInfo } from "../workspace/task-worktree.js";

export interface WorkspaceRegistryScope {
	workspaceId: string;
	workspacePath: string;
}

export interface CreateWorkspaceRegistryDependencies {
	cwd: string;
	loadGlobalRuntimeConfig: () => Promise<RuntimeConfigState>;
	loadRuntimeConfig: (cwd: string) => Promise<RuntimeConfigState>;
	hasGitRepository: (path: string) => boolean;
	pathIsDirectory: (path: string) => Promise<boolean>;
	approvalQueue?: SupervisorApprovalQueue;
	onTerminalManagerReady?: (workspaceId: string, manager: TerminalSessionManager) => void;
}

export interface DisposeWorkspaceRegistryOptions {
	stopTerminalSessions?: boolean;
}

export interface ResolvedWorkspaceStreamTarget {
	workspaceId: string | null;
	workspacePath: string | null;
	removedRequestedWorkspacePath: string | null;
	didPruneProjects: boolean;
}

export interface RemovedWorkspaceNotice {
	workspaceId: string;
	repoPath: string;
	message: string;
}

export interface WorkspaceRegistry {
	getActiveWorkspaceId: () => string | null;
	getActiveWorkspacePath: () => string | null;
	getWorkspacePathById: (workspaceId: string) => string | null;
	rememberWorkspace: (workspaceId: string, repoPath: string) => void;
	getActiveRuntimeConfig: () => RuntimeConfigState;
	setActiveRuntimeConfig: (config: RuntimeConfigState) => void;
	loadScopedRuntimeConfig: (scope: WorkspaceRegistryScope) => Promise<RuntimeConfigState>;
	getTerminalManagerForWorkspace: (workspaceId: string) => TerminalSessionManager | null;
	ensureTerminalManagerForWorkspace: (workspaceId: string, repoPath: string) => Promise<TerminalSessionManager>;
	setActiveWorkspace: (workspaceId: string, repoPath: string) => Promise<void>;
	clearActiveWorkspace: () => void;
	disposeWorkspace: (
		workspaceId: string,
		options?: DisposeWorkspaceRegistryOptions,
	) => {
		terminalManager: TerminalSessionManager | null;
		workspacePath: string | null;
	};
	summarizeProjectTaskCounts: (workspaceId: string, repoPath: string) => Promise<RuntimeProjectTaskCounts>;
	createProjectSummary: (input: {
		workspaceId: string;
		repoPath: string;
		taskCounts: RuntimeProjectTaskCounts;
	}) => RuntimeProjectSummary;
	buildWorkspaceStateSnapshot: (workspaceId: string, workspacePath: string) => Promise<RuntimeWorkspaceStateResponse>;
	invalidateWorkspaceSnapshotCache: (workspaceId: string) => void;
	buildProjectsPayload: (preferredCurrentProjectId: string | null) => Promise<{
		currentProjectId: string | null;
		projects: RuntimeProjectSummary[];
	}>;
	buildAggregateBoardSnapshot: () => Promise<{
		board: RuntimeAggregateBoardData;
		generatedAt: number;
	}>;
	resolveWorkspaceForStream: (
		requestedWorkspaceId: string | null,
		options?: {
			onRemovedWorkspace?: (workspace: RemovedWorkspaceNotice) => void;
		},
	) => Promise<ResolvedWorkspaceStreamTarget>;
	listManagedWorkspaces: () => Array<{
		workspaceId: string;
		workspacePath: string | null;
		terminalManager: TerminalSessionManager;
	}>;
}

function createEmptyProjectTaskCounts(): RuntimeProjectTaskCounts {
	return {
		backlog: 0,
		in_progress: 0,
		review: 0,
		trash: 0,
	};
}

function countTasksByColumn(board: RuntimeBoardData): RuntimeProjectTaskCounts {
	const counts = createEmptyProjectTaskCounts();
	for (const column of board.columns) {
		const count = column.cards.length;
		switch (column.id) {
			case "backlog":
				counts.backlog += count;
				break;
			case "in_progress":
				counts.in_progress += count;
				break;
			case "review":
				counts.review += count;
				break;
			case "trash":
				counts.trash += count;
				break;
		}
	}
	return counts;
}

export function collectProjectWorktreeTaskIdsForRemoval(board: RuntimeBoardData): Set<string> {
	const taskIds = new Set<string>();
	for (const column of board.columns) {
		if (column.id === "backlog" || column.id === "trash") {
			continue;
		}
		for (const card of column.cards) {
			taskIds.add(card.id);
		}
	}
	return taskIds;
}

function applyLiveSessionStateToProjectTaskCounts(
	counts: RuntimeProjectTaskCounts,
	board: RuntimeBoardData,
	sessionSummaries: RuntimeWorkspaceStateResponse["sessions"],
): RuntimeProjectTaskCounts {
	const taskColumnById = new Map<string, RuntimeBoardColumnId>();
	for (const column of board.columns) {
		for (const card of column.cards) {
			taskColumnById.set(card.id, column.id);
		}
	}
	const next = {
		...counts,
	};
	for (const summary of Object.values(sessionSummaries)) {
		const columnId = taskColumnById.get(summary.taskId);
		if (!columnId) {
			continue;
		}
		if (summary.state === "awaiting_review" && columnId === "in_progress") {
			next.in_progress = Math.max(0, next.in_progress - 1);
			next.review += 1;
		}
	}
	return next;
}

function toProjectSummary(project: {
	workspaceId: string;
	repoPath: string;
	taskCounts: RuntimeProjectTaskCounts;
}): RuntimeProjectSummary {
	const normalized = project.repoPath.replaceAll("\\", "/").replace(/\/+$/g, "");
	const segments = normalized.split("/").filter((segment) => segment.length > 0);
	const name = segments[segments.length - 1] ?? normalized;
	return {
		id: project.workspaceId,
		path: project.repoPath,
		name,
		taskCounts: project.taskCounts,
	};
}

async function buildTaskWorkspaceMetadata(
	repoPath: string,
	card: RuntimeWorkspaceStateResponse["board"]["columns"][number]["cards"][number],
): Promise<RuntimeTaskWorkspaceMetadata> {
	const pathInfo = await getTaskWorkspacePathInfo({
		cwd: repoPath,
		taskId: card.id,
		baseRef: card.baseRef,
	});

	if (!pathInfo.exists) {
		return {
			taskId: pathInfo.taskId,
			path: pathInfo.path,
			exists: false,
			baseRef: pathInfo.baseRef,
			branch: null,
			isDetached: false,
			headCommit: null,
			changedFiles: null,
			additions: null,
			deletions: null,
			stateVersion: Date.now(),
		};
	}

	try {
		const probe = await probeGitWorkspaceState(pathInfo.path);
		const summary = await getGitSyncSummary(pathInfo.path, { probe });
		return {
			taskId: pathInfo.taskId,
			path: pathInfo.path,
			exists: true,
			baseRef: pathInfo.baseRef,
			branch: probe.currentBranch,
			isDetached: probe.headCommit !== null && probe.currentBranch === null,
			headCommit: probe.headCommit,
			changedFiles: summary.changedFiles,
			additions: summary.additions,
			deletions: summary.deletions,
			stateVersion: Date.now(),
		};
	} catch {
		return {
			taskId: pathInfo.taskId,
			path: pathInfo.path,
			exists: true,
			baseRef: pathInfo.baseRef,
			branch: null,
			isDetached: false,
			headCommit: null,
			changedFiles: null,
			additions: null,
			deletions: null,
			stateVersion: Date.now(),
		};
	}
}

export async function createWorkspaceRegistry(deps: CreateWorkspaceRegistryDependencies): Promise<WorkspaceRegistry> {
	const launchedFromGitRepo = deps.hasGitRepository(deps.cwd);
	const initialWorkspace = launchedFromGitRepo ? await loadWorkspaceContext(deps.cwd) : null;
	let indexedWorkspace: RuntimeWorkspaceIndexEntry | null = null;
	if (!initialWorkspace) {
		const indexedWorkspaces = await listWorkspaceIndexEntries();
		indexedWorkspace = indexedWorkspaces[0] ?? null;
	}

	let activeWorkspaceId: string | null = initialWorkspace?.workspaceId ?? indexedWorkspace?.workspaceId ?? null;
	let activeWorkspacePath: string | null = initialWorkspace?.repoPath ?? indexedWorkspace?.repoPath ?? null;
	let globalRuntimeConfig = await deps.loadGlobalRuntimeConfig();
	let activeRuntimeConfig = activeWorkspacePath
		? await deps.loadRuntimeConfig(activeWorkspacePath)
		: globalRuntimeConfig;
	const workspacePathsById = new Map<string, string>(
		activeWorkspaceId && activeWorkspacePath ? [[activeWorkspaceId, activeWorkspacePath]] : [],
	);
	const projectTaskCountsByWorkspaceId = new Map<string, RuntimeProjectTaskCounts>();
	const terminalManagersByWorkspaceId = new Map<string, TerminalSessionManager>();
	const terminalManagerLoadPromises = new Map<string, Promise<TerminalSessionManager>>();
	const replayHistoryUnsubscribeByWorkspaceId = new Map<string, () => void>();

	const rememberWorkspace = (workspaceId: string, repoPath: string): void => {
		workspacePathsById.set(workspaceId, repoPath);
	};

	const notifyTerminalManagerReady = (workspaceId: string, manager: TerminalSessionManager): void => {
		deps.onTerminalManagerReady?.(workspaceId, manager);
	};

	const getTerminalManagerForWorkspace = (workspaceId: string): TerminalSessionManager | null => {
		return terminalManagersByWorkspaceId.get(workspaceId) ?? null;
	};

	const ensureTerminalManagerForWorkspace = async (
		workspaceId: string,
		repoPath: string,
	): Promise<TerminalSessionManager> => {
		rememberWorkspace(workspaceId, repoPath);
		const existing = terminalManagersByWorkspaceId.get(workspaceId);
		if (existing) {
			notifyTerminalManagerReady(workspaceId, existing);
			return existing;
		}
		const pending = terminalManagerLoadPromises.get(workspaceId);
		if (pending) {
			const loaded = await pending;
			notifyTerminalManagerReady(workspaceId, loaded);
			return loaded;
		}
		const loading = (async () => {
			const manager = new TerminalSessionManager({
				workspaceJournalDir: getWorkspaceJournalDir(workspaceId),
				approvalQueue: deps.approvalQueue,
			});
			try {
				const existingWorkspace = await loadWorkspaceStateById(workspaceId, repoPath);
				const legacyReplayHistoryByTaskId = await loadWorkspaceSessionReplayHistoryById(workspaceId);
				const replayHistoryByTaskId: Record<string, readonly Buffer[]> = {};
				const dir = getWorkspaceJournalDir(workspaceId);
				for (const taskId of Object.keys(existingWorkspace.sessions)) {
					const fromJournal = await OutputJournal.replay({ dir, taskId });
					replayHistoryByTaskId[taskId] =
						fromJournal.length > 0 ? fromJournal : (legacyReplayHistoryByTaskId[taskId] ?? []);
				}
				manager.hydrateFromRecord(existingWorkspace.sessions, replayHistoryByTaskId, workspaceId);
			} catch {
				// Workspace state will be created on demand.
			}
			const unsubscribeReplayHistory = manager.onReplayHistory((taskId, history) => {
				void saveWorkspaceTaskReplayHistoryById(workspaceId, taskId, history).catch(() => {
					// Best effort: replay history persistence should not break the runtime.
				});
			});
			replayHistoryUnsubscribeByWorkspaceId.set(workspaceId, unsubscribeReplayHistory);
			terminalManagersByWorkspaceId.set(workspaceId, manager);
			return manager;
		})().finally(() => {
			terminalManagerLoadPromises.delete(workspaceId);
		});
		terminalManagerLoadPromises.set(workspaceId, loading);
		const loaded = await loading;
		notifyTerminalManagerReady(workspaceId, loaded);
		return loaded;
	};

	const setActiveWorkspace = async (workspaceId: string, repoPath: string): Promise<void> => {
		activeWorkspaceId = workspaceId;
		activeWorkspacePath = repoPath;
		rememberWorkspace(workspaceId, repoPath);
		await ensureTerminalManagerForWorkspace(workspaceId, repoPath);
		activeRuntimeConfig = await deps.loadRuntimeConfig(repoPath);
		globalRuntimeConfig = toGlobalRuntimeConfigState(activeRuntimeConfig);
	};

	const clearActiveWorkspace = (): void => {
		activeWorkspaceId = null;
		activeWorkspacePath = null;
		activeRuntimeConfig = globalRuntimeConfig;
	};

	const disposeWorkspace = (
		workspaceId: string,
		options?: DisposeWorkspaceRegistryOptions,
	): { terminalManager: TerminalSessionManager | null; workspacePath: string | null } => {
		const terminalManager = getTerminalManagerForWorkspace(workspaceId);
		if (terminalManager) {
			if (options?.stopTerminalSessions !== false) {
				terminalManager.markInterruptedAndStopAll();
			}
			terminalManagersByWorkspaceId.delete(workspaceId);
			terminalManagerLoadPromises.delete(workspaceId);
		}
		const unsubscribeReplayHistory = replayHistoryUnsubscribeByWorkspaceId.get(workspaceId);
		if (unsubscribeReplayHistory) {
			unsubscribeReplayHistory();
			replayHistoryUnsubscribeByWorkspaceId.delete(workspaceId);
		}
		projectTaskCountsByWorkspaceId.delete(workspaceId);
		const workspacePath = workspacePathsById.get(workspaceId) ?? null;
		workspacePathsById.delete(workspaceId);
		return {
			terminalManager,
			workspacePath,
		};
	};

	const summarizeProjectTaskCounts = async (
		workspaceId: string,
		repoPath: string,
	): Promise<RuntimeProjectTaskCounts> => {
		try {
			const workspaceState = await loadWorkspaceStateById(workspaceId, repoPath);
			const persistedCounts = countTasksByColumn(workspaceState.board);
			const terminalManager = getTerminalManagerForWorkspace(workspaceId);
			if (!terminalManager) {
				projectTaskCountsByWorkspaceId.set(workspaceId, persistedCounts);
				return persistedCounts;
			}
			const liveSessionsByTaskId: RuntimeWorkspaceStateResponse["sessions"] = {};
			for (const summary of terminalManager.listSummaries()) {
				liveSessionsByTaskId[summary.taskId] = summary;
			}
			const nextCounts = applyLiveSessionStateToProjectTaskCounts(
				persistedCounts,
				workspaceState.board,
				liveSessionsByTaskId,
			);
			projectTaskCountsByWorkspaceId.set(workspaceId, nextCounts);
			return nextCounts;
		} catch {
			return projectTaskCountsByWorkspaceId.get(workspaceId) ?? createEmptyProjectTaskCounts();
		}
	};

	// Short-lived snapshot cache with in-flight dedup. External callers like
	// the Foundation EA dashboard poll every N projects; without dedup, each
	// tRPC workspace.getState hit re-reads the workspace state from disk and
	// re-enters the snapshot build path. 1s is short enough that mutations
	// still feel immediate (they invalidate via notifyStateUpdated) but long
	// enough to absorb a burst of concurrent polls.
	const WORKSPACE_SNAPSHOT_CACHE_TTL_MS = 1_000;
	const workspaceSnapshotCache = new Map<string, { expiresAt: number; value: RuntimeWorkspaceStateResponse }>();
	const workspaceSnapshotInFlight = new Map<string, Promise<RuntimeWorkspaceStateResponse>>();

	const invalidateWorkspaceSnapshotCache = (workspaceId: string): void => {
		workspaceSnapshotCache.delete(workspaceId);
	};

	const buildWorkspaceStateSnapshot = async (
		workspaceId: string,
		workspacePath: string,
	): Promise<RuntimeWorkspaceStateResponse> => {
		const cached = workspaceSnapshotCache.get(workspaceId);
		if (cached && cached.expiresAt > Date.now()) {
			return cached.value;
		}
		const existing = workspaceSnapshotInFlight.get(workspaceId);
		if (existing) {
			return await existing;
		}
		const promise = (async (): Promise<RuntimeWorkspaceStateResponse> => {
			const response = await loadWorkspaceStateById(workspaceId, workspacePath);
			// Only overlay *live* session state from an already-initialized
			// terminal manager. Previously this unconditionally awaited
			// ensureTerminalManagerForWorkspace, which hydrated session state
			// from disk and spun up the manager every time a polling client
			// (notably the Foundation EA dashboard) requested workspace
			// state. For non-active workspaces this added multi-second cold-
			// boot cost to what is supposed to be a read-only call, backing
			// up fs-kanban's request queue. Active/subscribed workspaces
			// still have their terminal manager initialized via
			// setActiveWorkspace and runtime-state-hub subscription paths,
			// so this only skips the work when nobody has asked us to
			// hydrate.
			const terminalManager = getTerminalManagerForWorkspace(workspaceId);
			if (terminalManager) {
				for (const summary of terminalManager.listSummaries()) {
					response.sessions[summary.taskId] = summary;
				}
			}
			workspaceSnapshotCache.set(workspaceId, {
				expiresAt: Date.now() + WORKSPACE_SNAPSHOT_CACHE_TTL_MS,
				value: response,
			});
			return response;
		})().finally(() => {
			workspaceSnapshotInFlight.delete(workspaceId);
		});
		workspaceSnapshotInFlight.set(workspaceId, promise);
		return await promise;
	};

	const buildProjectsPayload = async (preferredCurrentProjectId: string | null) => {
		const projects = await listWorkspaceIndexEntries();
		const fallbackProjectId =
			projects.find((project) => project.workspaceId === activeWorkspaceId)?.workspaceId ??
			projects[0]?.workspaceId ??
			null;
		const resolvedCurrentProjectId =
			(preferredCurrentProjectId &&
				projects.some((project) => project.workspaceId === preferredCurrentProjectId) &&
				preferredCurrentProjectId) ||
			fallbackProjectId;
		const projectSummaries = await Promise.all(
			projects.map(async (project) => {
				const taskCounts = await summarizeProjectTaskCounts(project.workspaceId, project.repoPath);
				return toProjectSummary({
					workspaceId: project.workspaceId,
					repoPath: project.repoPath,
					taskCounts,
				});
			}),
		);
		return {
			currentProjectId: resolvedCurrentProjectId,
			projects: projectSummaries,
		};
	};

	const buildAggregateBoardSnapshot = async (): Promise<{
		board: RuntimeAggregateBoardData;
		generatedAt: number;
	}> => {
		const projects = await listWorkspaceIndexEntries();
		const aggregateColumns: RuntimeAggregateBoardData["columns"] = [
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
		];

		for (const project of projects) {
			let workspaceState: RuntimeWorkspaceStateResponse;
			try {
				workspaceState = await loadWorkspaceStateById(project.workspaceId, project.repoPath);
			} catch {
				continue;
			}

			const terminalManager = getTerminalManagerForWorkspace(project.workspaceId);
			const sessions: RuntimeWorkspaceStateResponse["sessions"] = {
				...workspaceState.sessions,
			};
			if (terminalManager) {
				for (const summary of terminalManager.listSummaries()) {
					sessions[summary.taskId] = summary;
				}
			}

			const projectName = toProjectSummary({
				workspaceId: project.workspaceId,
				repoPath: project.repoPath,
				taskCounts: createEmptyProjectTaskCounts(),
			}).name;

			for (const column of workspaceState.board.columns) {
				if (column.id !== "in_progress" && column.id !== "review") {
					continue;
				}
				for (const card of column.cards) {
					const session = sessions[card.id] ?? null;
					const effectiveColumnId =
						column.id === "in_progress" && session?.state === "awaiting_review" ? "review" : column.id;
					const taskWorkspace = await buildTaskWorkspaceMetadata(project.repoPath, card);
					const aggregateCard: RuntimeAggregateBoardCard = {
						key: `${project.workspaceId}:${card.id}`,
						workspaceId: project.workspaceId,
						projectName,
						projectPath: project.repoPath,
						columnId: effectiveColumnId,
						card,
						session,
						taskWorkspace,
					};
					const targetColumn = aggregateColumns.find((candidate) => candidate.id === effectiveColumnId);
					targetColumn?.cards.push(aggregateCard);
				}
			}
		}

		for (const column of aggregateColumns) {
			column.cards.sort((left, right) => {
				const leftUpdatedAt = left.session?.updatedAt ?? left.card.updatedAt;
				const rightUpdatedAt = right.session?.updatedAt ?? right.card.updatedAt;
				if (leftUpdatedAt !== rightUpdatedAt) {
					return rightUpdatedAt - leftUpdatedAt;
				}
				const projectNameComparison = left.projectName.localeCompare(right.projectName);
				if (projectNameComparison !== 0) {
					return projectNameComparison;
				}
				return left.card.id.localeCompare(right.card.id);
			});
		}

		return {
			board: {
				columns: aggregateColumns,
			},
			generatedAt: Date.now(),
		};
	};

	const resolveWorkspaceForStream = async (
		requestedWorkspaceId: string | null,
		options?: {
			onRemovedWorkspace?: (workspace: RemovedWorkspaceNotice) => void;
		},
	): Promise<ResolvedWorkspaceStreamTarget> => {
		const allProjects = await listWorkspaceIndexEntries();
		const existingProjects: RuntimeWorkspaceIndexEntry[] = [];
		const removedProjects: RuntimeWorkspaceIndexEntry[] = [];

		for (const project of allProjects) {
			let removalMessage: string | null = null;
			if (!(await deps.pathIsDirectory(project.repoPath))) {
				removalMessage = `Project no longer exists on disk and was removed: ${project.repoPath}`;
			} else if (!deps.hasGitRepository(project.repoPath)) {
				removalMessage = `Project is not a git repository and was removed: ${project.repoPath}`;
			}

			if (!removalMessage) {
				existingProjects.push(project);
				continue;
			}

			removedProjects.push(project);
			await removeWorkspaceIndexEntry(project.workspaceId);
			await removeWorkspaceStateFiles(project.workspaceId);
			disposeWorkspace(project.workspaceId);
			options?.onRemovedWorkspace?.({
				workspaceId: project.workspaceId,
				repoPath: project.repoPath,
				message: removalMessage,
			});
		}

		const removedRequestedWorkspacePath = requestedWorkspaceId
			? (removedProjects.find((project) => project.workspaceId === requestedWorkspaceId)?.repoPath ?? null)
			: null;

		const activeWorkspaceMissing = !existingProjects.some((project) => project.workspaceId === activeWorkspaceId);
		if (activeWorkspaceMissing) {
			if (existingProjects[0]) {
				await setActiveWorkspace(existingProjects[0].workspaceId, existingProjects[0].repoPath);
			} else {
				clearActiveWorkspace();
			}
		}

		if (requestedWorkspaceId) {
			const requestedWorkspace = existingProjects.find((project) => project.workspaceId === requestedWorkspaceId);
			if (requestedWorkspace) {
				if (
					activeWorkspaceId !== requestedWorkspace.workspaceId ||
					activeWorkspacePath !== requestedWorkspace.repoPath
				) {
					await setActiveWorkspace(requestedWorkspace.workspaceId, requestedWorkspace.repoPath);
				}
				return {
					workspaceId: requestedWorkspace.workspaceId,
					workspacePath: requestedWorkspace.repoPath,
					removedRequestedWorkspacePath,
					didPruneProjects: removedProjects.length > 0,
				};
			}
		}

		const fallbackWorkspace =
			existingProjects.find((project) => project.workspaceId === activeWorkspaceId) ?? existingProjects[0] ?? null;
		if (!fallbackWorkspace) {
			return {
				workspaceId: null,
				workspacePath: null,
				removedRequestedWorkspacePath,
				didPruneProjects: removedProjects.length > 0,
			};
		}
		return {
			workspaceId: fallbackWorkspace.workspaceId,
			workspacePath: fallbackWorkspace.repoPath,
			removedRequestedWorkspacePath,
			didPruneProjects: removedProjects.length > 0,
		};
	};

	if (initialWorkspace) {
		await ensureTerminalManagerForWorkspace(initialWorkspace.workspaceId, initialWorkspace.repoPath);
	}

	return {
		getActiveWorkspaceId: () => activeWorkspaceId,
		getActiveWorkspacePath: () => activeWorkspacePath,
		getWorkspacePathById: (workspaceId: string) => workspacePathsById.get(workspaceId) ?? null,
		rememberWorkspace,
		getActiveRuntimeConfig: () => activeRuntimeConfig,
		setActiveRuntimeConfig: (config: RuntimeConfigState) => {
			globalRuntimeConfig = toGlobalRuntimeConfigState(config);
			activeRuntimeConfig = activeWorkspaceId ? config : globalRuntimeConfig;
		},
		loadScopedRuntimeConfig: async (scope: WorkspaceRegistryScope) => {
			if (scope.workspaceId === activeWorkspaceId) {
				return activeRuntimeConfig;
			}
			return await deps.loadRuntimeConfig(scope.workspacePath);
		},
		getTerminalManagerForWorkspace,
		ensureTerminalManagerForWorkspace,
		setActiveWorkspace,
		clearActiveWorkspace,
		disposeWorkspace,
		summarizeProjectTaskCounts,
		createProjectSummary: toProjectSummary,
		buildWorkspaceStateSnapshot,
		invalidateWorkspaceSnapshotCache,
		buildProjectsPayload,
		buildAggregateBoardSnapshot,
		resolveWorkspaceForStream,
		listManagedWorkspaces: () => {
			return Array.from(terminalManagersByWorkspaceId.entries()).map(([workspaceId, terminalManager]) => ({
				workspaceId,
				workspacePath: workspacePathsById.get(workspaceId) ?? null,
				terminalManager,
			}));
		},
	};
}
