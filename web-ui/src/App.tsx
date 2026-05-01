// Main React composition root for the browser app.
// Keep this file focused on wiring top-level hooks and surfaces together, and
// push runtime-specific orchestration down into hooks and service modules.
import { FolderOpen } from "lucide-react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActiveProjectsBoard } from "@/components/active-projects-board";
import { notifyError, showAppToast } from "@/components/app-toaster";
import { CardDetailView } from "@/components/card-detail-view";
import { ClearTrashDialog } from "@/components/clear-trash-dialog";
import { DebugDialog } from "@/components/debug-dialog";
import { AggregateColumnContextPanel } from "@/components/detail-panels/aggregate-column-context-panel";
import { AgentTerminalPanel } from "@/components/detail-panels/agent-terminal-panel";
import { GitHistoryView } from "@/components/git-history-view";
import { KanbanBoard } from "@/components/kanban-board";
import { ProjectNavigationPanel } from "@/components/project-navigation-panel";
import { ResizableBottomPane } from "@/components/resizable-bottom-pane";
import { RuntimeSettingsDialog, type RuntimeSettingsSection } from "@/components/runtime-settings-dialog";
import { StartupOnboardingDialog } from "@/components/startup-onboarding-dialog";
import { SupervisorPanel } from "@/components/supervisor-panel";
import { TaskCreateDialog } from "@/components/task-create-dialog";
import { TaskInlineCreateCard } from "@/components/task-inline-create-card";
import { TopBar } from "@/components/top-bar";
import { Button } from "@/components/ui/button";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogBody,
	AlertDialogCancel,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	Dialog,
	DialogBody,
	DialogHeader,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { createInitialBoardData } from "@/data/board-data";
import { createIdleTaskSession } from "@/hooks/app-utils";
import { RuntimeDisconnectedFallback } from "@/hooks/runtime-disconnected-fallback";
import { useAggregateBoard } from "@/hooks/use-aggregate-board";
import { useAggregateBoardActions } from "@/hooks/use-aggregate-board-actions";
import { useAppHotkeys } from "@/hooks/use-app-hotkeys";
import { useBoardInteractions } from "@/hooks/use-board-interactions";
import { useDebugTools } from "@/hooks/use-debug-tools";
import { useDocumentVisibility } from "@/hooks/use-document-visibility";
import { useGitActions } from "@/hooks/use-git-actions";
import { useHomeSidebarAgentPanel } from "@/hooks/use-home-sidebar-agent-panel";
import { useOpenWorkspace } from "@/hooks/use-open-workspace";
import { usePrewarmedAgentTerminals } from "@/hooks/use-prewarmed-agent-terminals";
import { parseRemovedProjectPathFromStreamError, useProjectNavigation } from "@/hooks/use-project-navigation";
import { useProjectUiState } from "@/hooks/use-project-ui-state";
import { useReviewReadyNotifications } from "@/hooks/use-review-ready-notifications";
import { useShortcutActions } from "@/hooks/use-shortcut-actions";
import { useStartupOnboarding } from "@/hooks/use-startup-onboarding";
import { useTaskBranchOptions } from "@/hooks/use-task-branch-options";
import { useTaskEditor } from "@/hooks/use-task-editor";
import { useTaskSessions } from "@/hooks/use-task-sessions";
import { useTaskStartActions } from "@/hooks/use-task-start-actions";
import { useTerminalPanels } from "@/hooks/use-terminal-panels";
import { useWorkspaceSnapshotCache } from "@/hooks/use-workspace-snapshot-cache";
import { useWorkspaceSync } from "@/hooks/use-workspace-sync";
import { getTaskAgentNavbarHint, isTaskAgentSetupSatisfied } from "@/runtime/native-agent";
import { getRuntimeTaskSessionStatus } from "@/runtime/task-session-status";
import type { RuntimeAggregateBoardCard, RuntimeTaskSessionSummary } from "@/runtime/types";
import { useApprovalQueue } from "@/runtime/use-approval-queue";
import { useRuntimeProjectConfig } from "@/runtime/use-runtime-project-config";
import { useTerminalConnectionReady } from "@/runtime/use-terminal-connection-ready";
import { useWorkspacePersistence } from "@/runtime/use-workspace-persistence";
import { saveWorkspaceState } from "@/runtime/workspace-state-query";
import { findCardSelection } from "@/state/board-state";
import {
	getTaskWorkspaceInfo,
	getTaskWorkspaceSnapshot,
	replaceWorkspaceMetadata,
	resetWorkspaceMetadataStore,
} from "@/stores/workspace-metadata-store";
import { TERMINAL_THEME_COLORS } from "@/terminal/theme-colors";
import type { BoardData } from "@/types";

const BACKLOG_CLEANUP_PROMPT = `Review the current backlog for this workspace and clean it up.

- Determine which backlog tasks are still relevant, already completed, duplicates, or stale.
- When you are confident a backlog task is already done, duplicated, or no longer relevant, move it to trash.
- Tighten vague backlog prompts so the remaining tasks are actionable and specific.
- If a task should be started now and is clearly ready, start it.
- If a task needs to be split, linked, or replaced by better-scoped tasks, do that.
- Only stop to ask me about items that are genuinely ambiguous or risky.
- Finish with a concise summary of what you changed and what still needs a human decision.`;

type DetailOrigin = "project" | "all-projects";

export default function App(): ReactElement {
	const [board, setBoard] = useState<BoardData>(() => createInitialBoardData());
	const [sessions, setSessions] = useState<Record<string, RuntimeTaskSessionSummary>>({});
	const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
	const [detailOrigin, setDetailOrigin] = useState<DetailOrigin>("project");
	const [canPersistWorkspaceState, setCanPersistWorkspaceState] = useState(false);
	const [isSettingsOpen, setIsSettingsOpen] = useState(false);
	const [settingsInitialSection, setSettingsInitialSection] = useState<RuntimeSettingsSection | null>(null);
	const [isSupervisorPanelOpen, setIsSupervisorPanelOpen] = useState(false);
	const [homeSidebarSection, setHomeSidebarSection] = useState<"projects" | "agent">("projects");
	const [isClearTrashDialogOpen, setIsClearTrashDialogOpen] = useState(false);
	const [isGitHistoryOpen, setIsGitHistoryOpen] = useState(false);
	const [pendingTaskStartAfterEditId, setPendingTaskStartAfterEditId] = useState<string | null>(null);
	const [pendingAggregateCardSelection, setPendingAggregateCardSelection] = useState<{
		workspaceId: string;
		taskId: string;
	} | null>(null);
	const taskEditorResetRef = useRef<() => void>(() => {});
	const lastStreamErrorRef = useRef<string | null>(null);
	const handleProjectSwitchStart = useCallback(() => {
		setCanPersistWorkspaceState(false);
		setSelectedTaskId(null);
		setIsGitHistoryOpen(false);
		setPendingTaskStartAfterEditId(null);
		taskEditorResetRef.current();
	}, []);
	const {
		isAggregateView,
		currentProjectId,
		projects,
		workspaceState: streamedWorkspaceState,
		workspaceMetadata,
		latestTaskReadyForReview,
		approvalQueueState,
		dispatchSeedApprovals,
		streamError,
		isRuntimeDisconnected,
		hasReceivedSnapshot,
		navigationCurrentProjectId,
		removingProjectId,
		hasNoProjects,
		isProjectSwitching,
		handleSelectProject,
		handleSelectAllProjects,
		handleAddProject,
		handleConfirmInitializeGitProject,
		handleCancelInitializeGitProject,
		handleRemoveProject,
		pendingGitInitializationPath,
		isInitializingGitProject,
		resetProjectNavigationState,
	} = useProjectNavigation({
		onProjectSwitchStart: handleProjectSwitchStart,
	});
	const {
		pending: approvalQueuePending,
		recent: approvalQueueRecent,
		decide: decideApproval,
	} = useApprovalQueue({
		workspaceId: currentProjectId,
		approvalQueueState,
		dispatchSeedApprovals,
	});
	const handleOpenSupervisorPanel = useCallback(() => {
		setIsSupervisorPanelOpen(true);
	}, []);
	const handleSupervisorDecision = useCallback(
		async (requestId: string, decision: "approved" | "denied") => {
			try {
				await decideApproval(requestId, decision);
			} catch (error) {
				notifyError(error instanceof Error ? error.message : "Could not apply decision.");
			}
		},
		[decideApproval],
	);
	const {
		projects: aggregateProjects,
		board: aggregateBoard,
		streamError: aggregateStreamError,
		isRuntimeDisconnected: isAggregateRuntimeDisconnected,
		hasReceivedSnapshot: hasReceivedAggregateSnapshot,
	} = useAggregateBoard(isAggregateView || detailOrigin === "all-projects");
	const activeNotificationWorkspaceId = navigationCurrentProjectId;
	const isDocumentVisible = useDocumentVisibility();
	const isInitialRuntimeLoad =
		!hasReceivedSnapshot && currentProjectId === null && projects.length === 0 && !streamError;
	const isAwaitingWorkspaceSnapshot = currentProjectId !== null && streamedWorkspaceState === null;
	const {
		config: runtimeProjectConfig,
		isLoading: isRuntimeProjectConfigLoading,
		refresh: refreshRuntimeProjectConfig,
	} = useRuntimeProjectConfig(currentProjectId);
	const isTaskAgentReady = isTaskAgentSetupSatisfied(runtimeProjectConfig);
	const settingsWorkspaceId = navigationCurrentProjectId ?? currentProjectId;
	const { config: settingsRuntimeProjectConfig, refresh: refreshSettingsRuntimeProjectConfig } =
		useRuntimeProjectConfig(settingsWorkspaceId);
	const {
		isStartupOnboardingDialogOpen,
		handleOpenStartupOnboardingDialog,
		handleCloseStartupOnboardingDialog,
		handleSelectOnboardingAgent,
		handleOnboardingAgentSetupSaved,
	} = useStartupOnboarding({
		currentProjectId,
		runtimeProjectConfig,
		isRuntimeProjectConfigLoading,
		isTaskAgentReady,
		refreshRuntimeProjectConfig,
		refreshSettingsRuntimeProjectConfig,
	});
	const {
		debugModeEnabled,
		isDebugDialogOpen,
		isResetAllStatePending,
		handleOpenDebugDialog,
		handleShowStartupOnboardingDialog,
		handleDebugDialogOpenChange,
		handleResetAllState,
	} = useDebugTools({
		runtimeProjectConfig,
		settingsRuntimeProjectConfig,
		onOpenStartupOnboardingDialog: handleOpenStartupOnboardingDialog,
	});
	const {
		markConnectionReady: markTerminalConnectionReady,
		prepareWaitForConnection: prepareWaitForTerminalConnectionReady,
	} = useTerminalConnectionReady();
	const agentAttentionNotificationsEnabled = runtimeProjectConfig?.agentAttentionNotificationsEnabled ?? true;
	const agentAttentionSoundEnabled = runtimeProjectConfig?.agentAttentionSoundEnabled ?? false;
	const readyForReviewNotificationsEnabled = runtimeProjectConfig?.readyForReviewNotificationsEnabled ?? true;
	const shortcuts = runtimeProjectConfig?.shortcuts ?? [];
	const selectedShortcutLabel = useMemo(() => {
		if (shortcuts.length === 0) {
			return null;
		}
		const configured = runtimeProjectConfig?.selectedShortcutLabel ?? null;
		if (configured && shortcuts.some((shortcut) => shortcut.label === configured)) {
			return configured;
		}
		return shortcuts[0]?.label ?? null;
	}, [runtimeProjectConfig?.selectedShortcutLabel, shortcuts]);
	const {
		upsertSession,
		ensureTaskWorkspace,
		startTaskSession,
		stopTaskSession,
		sendTaskSessionInput,
		cleanupTaskWorkspace,
		fetchTaskWorkspaceInfo,
	} = useTaskSessions({
		currentProjectId,
		setSessions,
	});

	const selectedCard = useMemo(() => {
		if (!selectedTaskId) {
			return null;
		}
		return findCardSelection(board, selectedTaskId);
	}, [board, selectedTaskId]);
	const {
		workspacePath,
		workspaceGit,
		workspaceRevision,
		setWorkspaceRevision,
		workspaceHydrationNonce,
		isWorkspaceStateRefreshing,
		isWorkspaceMetadataPending,
		refreshWorkspaceState,
		resetWorkspaceSyncState,
	} = useWorkspaceSync({
		currentProjectId,
		streamedWorkspaceState,
		hasNoProjects,
		hasReceivedSnapshot,
		isDocumentVisible,
		setBoard,
		setSessions,
		setCanPersistWorkspaceState,
	});
	const { getCachedWorkspaceSnapshot } = useWorkspaceSnapshotCache({
		currentProjectId,
		workspaceState: streamedWorkspaceState,
		workspaceMetadata,
	});

	useEffect(() => {
		replaceWorkspaceMetadata(workspaceMetadata);
	}, [workspaceMetadata]);

	useEffect(() => {
		if (!isProjectSwitching) {
			return;
		}
		resetWorkspaceMetadataStore();
	}, [isProjectSwitching]);

	const {
		displayedProjects,
		navigationProjectPath,
		shouldShowProjectLoadingState,
		isProjectListLoading,
		shouldUseNavigationPath,
	} = useProjectUiState({
		board,
		canPersistWorkspaceState,
		currentProjectId,
		projects,
		navigationCurrentProjectId,
		selectedTaskId,
		streamError,
		isProjectSwitching,
		isInitialRuntimeLoad,
		isAwaitingWorkspaceSnapshot,
		isWorkspaceMetadataPending,
		hasReceivedSnapshot,
	});
	const cachedNavigationWorkspaceSnapshot =
		isAggregateView || !isProjectSwitching ? null : getCachedWorkspaceSnapshot(navigationCurrentProjectId);
	const displayedBoard = cachedNavigationWorkspaceSnapshot?.workspaceState.board ?? board;
	const displayedSessions = cachedNavigationWorkspaceSnapshot?.workspaceState.sessions ?? sessions;
	const displayedWorkspacePath = cachedNavigationWorkspaceSnapshot?.workspaceState.repoPath ?? workspacePath;
	const sidebarProjects = isAggregateView && hasReceivedAggregateSnapshot ? aggregateProjects : displayedProjects;
	const sidebarIsLoadingProjects =
		isAggregateView && !hasReceivedAggregateSnapshot && !aggregateStreamError ? true : isProjectListLoading;
	const shouldShowProjectLoadingStateWithCache =
		shouldShowProjectLoadingState && cachedNavigationWorkspaceSnapshot === null;

	useReviewReadyNotifications({
		activeWorkspaceId: activeNotificationWorkspaceId,
		agentAttentionNotificationsEnabled,
		agentAttentionSoundEnabled,
		board,
		isDocumentVisible,
		latestTaskReadyForReview,
		taskSessions: sessions,
		readyForReviewNotificationsEnabled,
		workspacePath,
	});

	const { createTaskBranchOptions, defaultTaskBranchRef } = useTaskBranchOptions({ workspaceGit });
	const queueTaskStartAfterEdit = useCallback((taskId: string) => {
		setPendingTaskStartAfterEditId(taskId);
	}, []);

	const {
		isInlineTaskCreateOpen,
		newTaskPrompt,
		setNewTaskPrompt,
		newTaskAttachments,
		setNewTaskAttachments,
		newTaskStartInPlanMode,
		setNewTaskStartInPlanMode,
		newTaskAutoReviewEnabled,
		setNewTaskAutoReviewEnabled,
		newTaskAutoReviewMode,
		setNewTaskAutoReviewMode,
		isNewTaskStartInPlanModeDisabled,
		newTaskBranchRef,
		setNewTaskBranchRef,
		newTaskAgentPreference,
		setNewTaskAgentPreference,
		newTaskFallbackAgentPreference,
		setNewTaskFallbackAgentPreference,
		editingTaskId,
		editTaskPrompt,
		setEditTaskPrompt,
		editTaskAttachments,
		setEditTaskAttachments,
		editTaskStartInPlanMode,
		setEditTaskStartInPlanMode,
		editTaskAutoReviewEnabled,
		setEditTaskAutoReviewEnabled,
		editTaskAutoReviewMode,
		setEditTaskAutoReviewMode,
		isEditTaskStartInPlanModeDisabled,
		editTaskBranchRef,
		setEditTaskBranchRef,
		editTaskAgentPreference,
		setEditTaskAgentPreference,
		editTaskFallbackAgentPreference,
		setEditTaskFallbackAgentPreference,
		handleOpenCreateTask,
		handleCancelCreateTask,
		handleOpenEditTask,
		handleCancelEditTask,
		handleSaveEditedTask,
		handleSaveAndStartEditedTask,
		handleCreateTask,
		handleCreateTasks,
		resetTaskEditorState,
	} = useTaskEditor({
		board,
		setBoard,
		currentProjectId,
		createTaskBranchOptions,
		defaultTaskBranchRef,
		runtimeConfig: runtimeProjectConfig ?? null,
		setSelectedTaskId,
		queueTaskStartAfterEdit,
	});

	useEffect(() => {
		taskEditorResetRef.current = resetTaskEditorState;
	}, [resetTaskEditorState]);

	useEffect(() => {
		if (!isProjectSwitching) {
			return;
		}
		resetWorkspaceSyncState();
	}, [isProjectSwitching, resetWorkspaceSyncState]);

	useEffect(() => {
		if (!isProjectSwitching) {
			return;
		}
		resetTaskEditorState();
	}, [isProjectSwitching, resetTaskEditorState]);

	const {
		runningGitAction,
		taskGitActionLoadingByTaskId,
		commitTaskLoadingById,
		openPrTaskLoadingById,
		agentCommitTaskLoadingById,
		agentOpenPrTaskLoadingById,
		isDiscardingHomeWorkingChanges,
		gitActionError,
		gitActionErrorTitle,
		clearGitActionError,
		gitHistory,
		runGitAction,
		switchHomeBranch,
		discardHomeWorkingChanges,
		handleCommitTask,
		handleOpenPrTask,
		handleAgentCommitTask,
		handleAgentOpenPrTask,
		runAutoReviewGitAction,
		resetGitActionState,
	} = useGitActions({
		currentProjectId,
		board,
		selectedCard,
		runtimeProjectConfig,
		sendTaskSessionInput,
		fetchTaskWorkspaceInfo,
		isGitHistoryOpen,
		refreshWorkspaceState,
	});
	const {
		commitTaskLoadingById: aggregateCommitTaskLoadingById,
		openPrTaskLoadingById: aggregateOpenPrTaskLoadingById,
		moveToTrashLoadingById: aggregateMoveToTrashLoadingById,
		handleCommitTask: handleAggregateCommitTask,
		handleOpenPrTask: handleAggregateOpenPrTask,
		handleMoveToTrashTask: handleAggregateMoveToTrashTask,
		handleCancelAutomaticTaskAction: handleAggregateCancelAutomaticTaskAction,
	} = useAggregateBoardActions();
	const agentCommand = runtimeProjectConfig?.effectiveCommand ?? null;
	const {
		homeTerminalTaskId,
		isHomeTerminalOpen,
		isHomeTerminalStarting,
		homeTerminalPaneHeight,
		isDetailTerminalOpen,
		detailTerminalTaskId,
		isDetailTerminalStarting,
		detailTerminalPaneHeight,
		isHomeTerminalExpanded,
		isDetailTerminalExpanded,
		setHomeTerminalPaneHeight,
		setDetailTerminalPaneHeight,
		handleToggleExpandHomeTerminal,
		handleToggleExpandDetailTerminal,
		handleToggleHomeTerminal,
		handleToggleDetailTerminal,
		handleSendAgentCommandToHomeTerminal,
		handleSendAgentCommandToDetailTerminal,
		prepareTerminalForShortcut,
		closeHomeTerminal,
		closeDetailTerminal,
		resetTerminalPanelsState,
	} = useTerminalPanels({
		currentProjectId,
		selectedCard,
		workspaceGit,
		agentCommand,
		upsertSession,
		sendTaskSessionInput,
	});
	usePrewarmedAgentTerminals({
		currentProjectId,
		isWorkspaceReady: !isWorkspaceMetadataPending,
		isRuntimeDisconnected,
		board,
		sessions,
		cursorColor: TERMINAL_THEME_COLORS.textPrimary,
		terminalBackgroundColor: TERMINAL_THEME_COLORS.surfacePrimary,
	});
	const homeTerminalSummary = sessions[homeTerminalTaskId] ?? null;
	const {
		panel: homeSidebarAgentPanel,
		summary: homeSidebarAgentSummary,
		taskId: homeSidebarAgentTaskId,
		restartSession: restartHomeSidebarAgent,
	} = useHomeSidebarAgentPanel({
		currentProjectId,
		hasNoProjects,
		runtimeProjectConfig,
		taskSessions: sessions,
		workspaceGit,
	});
	const { runningShortcutLabel, handleSelectShortcutLabel, handleRunShortcut, handleCreateShortcut } =
		useShortcutActions({
			currentProjectId,
			selectedShortcutLabel: runtimeProjectConfig?.selectedShortcutLabel,
			shortcuts,
			refreshRuntimeProjectConfig,
			prepareTerminalForShortcut,
			prepareWaitForTerminalConnectionReady,
			sendTaskSessionInput,
		});

	const persistWorkspaceStateAsync = useCallback(
		async (input: { workspaceId: string; payload: Parameters<typeof saveWorkspaceState>[1] }) =>
			await saveWorkspaceState(input.workspaceId, input.payload),
		[],
	);
	const handleWorkspaceStateConflict = useCallback(() => {
		showAppToast(
			{
				intent: "warning",
				icon: "warning-sign",
				message: "Workspace changed elsewhere. Synced latest state. Retry your last edit if needed.",
				timeout: 5000,
			},
			"workspace-state-conflict",
		);
	}, []);

	useWorkspacePersistence({
		board,
		sessions,
		currentProjectId,
		workspaceRevision,
		hydrationNonce: workspaceHydrationNonce,
		canPersistWorkspaceState,
		isDocumentVisible,
		isWorkspaceStateRefreshing,
		persistWorkspaceState: persistWorkspaceStateAsync,
		refetchWorkspaceState: refreshWorkspaceState,
		onWorkspaceRevisionChange: setWorkspaceRevision,
		onWorkspaceStateConflict: handleWorkspaceStateConflict,
	});

	useEffect(() => {
		if (!streamError) {
			lastStreamErrorRef.current = null;
			return;
		}
		const removedPath = parseRemovedProjectPathFromStreamError(streamError);
		if (removedPath !== null) {
			showAppToast(
				{
					intent: "danger",
					icon: "warning-sign",
					message: removedPath
						? `Project no longer exists and was removed: ${removedPath}`
						: "Project no longer exists and was removed.",
					timeout: 6000,
				},
				`project-removed-${removedPath || "unknown"}`,
			);
			lastStreamErrorRef.current = null;
			return;
		}
		if (isRuntimeDisconnected) {
			lastStreamErrorRef.current = streamError;
			return;
		}
		if (lastStreamErrorRef.current !== streamError) {
			notifyError(streamError, { key: `error:${streamError}` });
		}
		lastStreamErrorRef.current = streamError;
	}, [isRuntimeDisconnected, streamError]);

	useEffect(() => {
		setSelectedTaskId(null);
		resetTaskEditorState();
		setIsClearTrashDialogOpen(false);
		resetGitActionState();
		resetProjectNavigationState();
		resetTerminalPanelsState();
	}, [
		currentProjectId,
		resetGitActionState,
		resetProjectNavigationState,
		resetTaskEditorState,
		resetTerminalPanelsState,
	]);

	useEffect(() => {
		if (selectedTaskId && !selectedCard) {
			setSelectedTaskId(null);
		}
	}, [selectedTaskId, selectedCard]);

	useEffect(() => {
		if (!pendingAggregateCardSelection) {
			return;
		}
		if (currentProjectId !== pendingAggregateCardSelection.workspaceId) {
			return;
		}
		setSelectedTaskId(pendingAggregateCardSelection.taskId);
		setPendingAggregateCardSelection(null);
	}, [currentProjectId, pendingAggregateCardSelection]);

	useEffect(() => {
		if (selectedCard) {
			return;
		}
		if (hasNoProjects || !currentProjectId) {
			if (isHomeTerminalOpen) {
				closeHomeTerminal();
			}
			return;
		}
	}, [closeHomeTerminal, currentProjectId, hasNoProjects, isHomeTerminalOpen, selectedCard]);
	const showHomeBottomTerminal = !selectedCard && !hasNoProjects && isHomeTerminalOpen;
	const homeTerminalSubtitle = useMemo(
		() => workspacePath ?? navigationProjectPath ?? null,
		[navigationProjectPath, workspacePath],
	);

	const handleBack = useCallback(() => {
		setSelectedTaskId(null);
		setIsGitHistoryOpen(false);
		if (detailOrigin === "all-projects") {
			setDetailOrigin("project");
			handleSelectAllProjects();
		}
	}, [detailOrigin, handleSelectAllProjects]);
	const handleAggregateCardSelect = useCallback(
		(card: RuntimeAggregateBoardCard) => {
			setDetailOrigin("all-projects");
			setPendingAggregateCardSelection({
				workspaceId: card.workspaceId,
				taskId: card.card.id,
			});
			handleSelectProject(card.workspaceId);
		},
		[handleSelectProject],
	);
	const selectedAggregateCardKey =
		detailOrigin === "all-projects" && currentProjectId && selectedTaskId
			? `${currentProjectId}:${selectedTaskId}`
			: null;
	const aggregateDetailSidebarPanel =
		detailOrigin === "all-projects" ? (
			<AggregateColumnContextPanel
				data={aggregateBoard}
				selectedCardKey={selectedAggregateCardKey}
				onCardSelect={handleAggregateCardSelect}
				onCommitTask={handleAggregateCommitTask}
				onOpenPrTask={handleAggregateOpenPrTask}
				onMoveToTrashTask={handleAggregateMoveToTrashTask}
				onCancelAutomaticTaskAction={handleAggregateCancelAutomaticTaskAction}
				commitTaskLoadingById={aggregateCommitTaskLoadingById}
				openPrTaskLoadingById={aggregateOpenPrTaskLoadingById}
				moveToTrashLoadingById={aggregateMoveToTrashLoadingById}
			/>
		) : undefined;

	const handleOpenSettings = useCallback((section?: RuntimeSettingsSection) => {
		setSettingsInitialSection(section ?? null);
		setIsSettingsOpen(true);
	}, []);
	const handleToggleGitHistory = useCallback(() => {
		if (hasNoProjects) {
			return;
		}
		setIsGitHistoryOpen((current) => !current);
	}, [hasNoProjects]);
	const handleCloseGitHistory = useCallback(() => {
		setIsGitHistoryOpen(false);
	}, []);

	const {
		handleProgrammaticCardMoveReady,
		handleCreateDependency,
		handleDeleteDependency,
		handleDragEnd,
		handleStartTask,
		handleStartAllBacklogTasks,
		handleDetailTaskDragEnd,
		handleCardSelect,
		handleMoveToTrash,
		handleMoveReviewCardToTrash,
		handleRestoreTaskFromTrash,
		handleRetryTaskWithAgent,
		handleCancelAutomaticTaskAction,
		handleOpenClearTrash,
		handleConfirmClearTrash,
		handleAddReviewComments,
		handleSendReviewComments,
		moveToTrashLoadingById,
		trashTaskCount,
	} = useBoardInteractions({
		board,
		setBoard,
		sessions,
		setSessions,
		selectedCard,
		selectedTaskId,
		currentProjectId,
		setSelectedTaskId,
		setIsClearTrashDialogOpen,
		setIsGitHistoryOpen,
		stopTaskSession,
		cleanupTaskWorkspace,
		ensureTaskWorkspace,
		startTaskSession,
		fetchTaskWorkspaceInfo,
		sendTaskSessionInput,
		readyForReviewNotificationsEnabled,
		runtimeConfig: runtimeProjectConfig ?? null,
		taskGitActionLoadingByTaskId,
		runAutoReviewGitAction,
	});

	const {
		handleCreateAndStartTask,
		handleCreateAndStartTasks,
		handleCreateStartAndOpenTask,
		handleStartTaskFromBoard,
		handleStartAllBacklogTasksFromBoard,
	} = useTaskStartActions({
		board,
		handleCreateTask,
		handleCreateTasks,
		handleStartTask,
		handleStartAllBacklogTasks,
		setSelectedTaskId,
	});

	const handleRunBacklogCleanup = useCallback(async () => {
		const backlogColumn = board.columns.find((column) => column.id === "backlog");
		if (!currentProjectId || !homeSidebarAgentTaskId) {
			notifyError("Board agent is not ready yet. Open Settings and make sure an agent CLI is configured.");
			return;
		}
		if (!backlogColumn || backlogColumn.cards.length === 0) {
			showAppToast({
				intent: "warning",
				message: "Backlog is already empty.",
				timeout: 4000,
			});
			return;
		}
		// Auto-recover from interrupted/failed: restart the home agent and tell
		// the user to retry once it's ready. (Sending input to a dead session
		// would just be lost.)
		const homeAgentStatus = homeSidebarAgentSummary
			? getRuntimeTaskSessionStatus(homeSidebarAgentSummary)
			: null;
		if (
			homeAgentStatus &&
			(homeAgentStatus.kind === "interrupted" || homeAgentStatus.kind === "failed")
		) {
			showAppToast({
				intent: "primary",
				message: "Restarting board agent — try cleanup again once it's ready.",
				timeout: 4000,
			});
			try {
				await restartHomeSidebarAgent();
			} catch (error) {
				notifyError(error instanceof Error ? error.message : "Could not restart the board agent.");
			}
			return;
		}
		// Refuse only when the agent is actively waiting on the user. Don't
		// block on bare "running" — the home/sidebar agent is just a board
		// helper, and a fresh-start "running" window before its prompt arrives
		// is the most common case where the user clicks cleanup. The runtime
		// will buffer the input.
		if (homeAgentStatus?.kind === "needs_approval") {
			showAppToast({
				intent: "warning",
				message: "Board agent is waiting for approval. Approve that step before starting backlog cleanup.",
				timeout: 6000,
			});
			return;
		}
		if (homeAgentStatus?.kind === "needs_input" || homeAgentStatus?.kind === "needs_review") {
			showAppToast({
				intent: "warning",
				message: "Board agent already needs your attention. Resolve that first, then run cleanup again.",
				timeout: 6000,
			});
			return;
		}
		// Fall through for: idle / awaiting_review (ready_for_review) / running
		// without active work / no summary yet (just-started). The runtime
		// buffers the cleanup prompt; codex/claude pick it up on the next
		// prompt cycle.
		const result = await sendTaskSessionInput(homeSidebarAgentTaskId, BACKLOG_CLEANUP_PROMPT, {
			appendNewline: true,
		});
		if (!result.ok) {
			notifyError(result.message ?? "Could not start backlog cleanup.");
			return;
		}
		showAppToast({
			intent: "success",
			message: "Backlog cleanup started in the board agent.",
			timeout: 4000,
		});
	}, [
		board.columns,
		currentProjectId,
		homeSidebarAgentSummary,
		homeSidebarAgentTaskId,
		restartHomeSidebarAgent,
		sendTaskSessionInput,
	]);

	const handleRestartBoardAgent = useCallback(async () => {
		if (!homeSidebarAgentTaskId) {
			notifyError("Board agent is not ready yet. Open Settings and make sure an agent CLI is configured.");
			return;
		}
		showAppToast({
			intent: "primary",
			message: "Restarting board agent…",
			timeout: 3000,
		});
		try {
			await restartHomeSidebarAgent();
		} catch (error) {
			notifyError(error instanceof Error ? error.message : "Could not restart the board agent.");
		}
	}, [homeSidebarAgentTaskId, restartHomeSidebarAgent]);

	useAppHotkeys({
		selectedCard,
		isDetailTerminalOpen,
		isHomeTerminalOpen: showHomeBottomTerminal,
		isHomeGitHistoryOpen: !selectedCard && isGitHistoryOpen,
		canUseCreateTaskShortcut: !isAggregateView && !hasNoProjects && currentProjectId !== null,
		handleToggleDetailTerminal,
		handleToggleHomeTerminal,
		handleToggleExpandDetailTerminal,
		handleToggleExpandHomeTerminal: handleToggleExpandHomeTerminal,
		handleOpenCreateTask,
		handleOpenSettings,
		handleToggleGitHistory,
		handleCloseGitHistory,
		onStartAllTasks: handleStartAllBacklogTasksFromBoard,
	});

	useEffect(() => {
		if (!pendingTaskStartAfterEditId) {
			return;
		}
		const selection = findCardSelection(board, pendingTaskStartAfterEditId);
		if (!selection || selection.column.id !== "backlog") {
			return;
		}
		handleStartTaskFromBoard(pendingTaskStartAfterEditId);
		setPendingTaskStartAfterEditId(null);
	}, [board, handleStartTaskFromBoard, pendingTaskStartAfterEditId]);

	const detailSession = selectedCard
		? (sessions[selectedCard.card.id] ?? createIdleTaskSession(selectedCard.card.id))
		: null;
	const detailTerminalSummary = detailTerminalTaskId ? (sessions[detailTerminalTaskId] ?? null) : null;
	const detailTerminalSubtitle = useMemo(() => {
		if (!selectedCard) {
			return null;
		}
		return (
			getTaskWorkspaceInfo(selectedCard.card.id, selectedCard.card.baseRef)?.path ??
			getTaskWorkspaceSnapshot(selectedCard.card.id)?.path ??
			null
		);
	}, [selectedCard]);

	const runtimeHint = useMemo(() => {
		return getTaskAgentNavbarHint(runtimeProjectConfig, {
			shouldUseNavigationPath,
		});
	}, [runtimeProjectConfig, shouldUseNavigationPath]);

	const activeWorkspacePath = selectedCard
		? (getTaskWorkspaceInfo(selectedCard.card.id, selectedCard.card.baseRef)?.path ??
			getTaskWorkspaceSnapshot(selectedCard.card.id)?.path ??
			displayedWorkspacePath ??
			undefined)
		: isAggregateView
			? "All Projects"
			: shouldUseNavigationPath
				? (navigationProjectPath ?? undefined)
				: (displayedWorkspacePath ?? undefined);

	const activeWorkspaceHint = useMemo(() => {
		if (!selectedCard) {
			return undefined;
		}
		const activeSelectedTaskWorkspaceInfo = getTaskWorkspaceInfo(selectedCard.card.id, selectedCard.card.baseRef);
		if (!activeSelectedTaskWorkspaceInfo) {
			return undefined;
		}
		if (!activeSelectedTaskWorkspaceInfo.exists) {
			return selectedCard.column.id === "trash" ? "Task worktree deleted" : "Task worktree not created yet";
		}
		return undefined;
	}, [selectedCard]);

	const navbarWorkspacePath = hasNoProjects ? undefined : activeWorkspacePath;
	const navbarWorkspaceHint = hasNoProjects ? undefined : activeWorkspaceHint;
	const navbarRuntimeHint = hasNoProjects ? undefined : runtimeHint;
	const shouldHideProjectDependentTopBarActions =
		isAggregateView ||
		(!selectedCard && (isProjectSwitching || isAwaitingWorkspaceSnapshot || isWorkspaceMetadataPending));

	const {
		openTargetOptions,
		selectedOpenTargetId,
		onSelectOpenTarget,
		onOpenWorkspace,
		canOpenWorkspace,
		isOpeningWorkspace,
	} = useOpenWorkspace({
		currentProjectId: isAggregateView ? null : currentProjectId,
		workspacePath: isAggregateView ? undefined : activeWorkspacePath,
	});
	const handleCreateDialogOpenChange = useCallback(
		(open: boolean) => {
			if (!open) {
				handleCancelCreateTask();
			}
		},
		[handleCancelCreateTask],
	);

	const inlineTaskEditor = editingTaskId ? (
		<TaskInlineCreateCard
			prompt={editTaskPrompt}
			onPromptChange={setEditTaskPrompt}
			attachments={editTaskAttachments}
			onAttachmentsChange={setEditTaskAttachments}
			onCreate={handleSaveEditedTask}
			onCreateAndStart={handleSaveAndStartEditedTask}
			onCancel={handleCancelEditTask}
			startInPlanMode={editTaskStartInPlanMode}
			onStartInPlanModeChange={setEditTaskStartInPlanMode}
			startInPlanModeDisabled={isEditTaskStartInPlanModeDisabled}
			autoReviewEnabled={editTaskAutoReviewEnabled}
			onAutoReviewEnabledChange={setEditTaskAutoReviewEnabled}
			autoReviewMode={editTaskAutoReviewMode}
			onAutoReviewModeChange={setEditTaskAutoReviewMode}
			workspaceId={currentProjectId}
			runtimeConfig={runtimeProjectConfig ?? null}
			branchRef={editTaskBranchRef}
			branchOptions={createTaskBranchOptions}
			onBranchRefChange={setEditTaskBranchRef}
			agentPreference={editTaskAgentPreference}
			onAgentPreferenceChange={setEditTaskAgentPreference}
			fallbackAgentPreference={editTaskFallbackAgentPreference}
			onFallbackAgentPreferenceChange={setEditTaskFallbackAgentPreference}
			mode="edit"
			idPrefix={`inline-edit-task-${editingTaskId}`}
		/>
	) : undefined;

	if ((isAggregateView && isAggregateRuntimeDisconnected) || (!isAggregateView && isRuntimeDisconnected)) {
		return <RuntimeDisconnectedFallback />;
	}

	return (
		<div className="flex h-[100svh] min-w-0 overflow-hidden">
			{!selectedCard ? (
				<ProjectNavigationPanel
					projects={sidebarProjects}
					isLoadingProjects={sidebarIsLoadingProjects}
					currentProjectId={navigationCurrentProjectId}
					isAllProjectsSelected={isAggregateView}
					removingProjectId={removingProjectId}
					activeSection={homeSidebarSection}
					onActiveSectionChange={setHomeSidebarSection}
					canShowAgentSection={!isAggregateView && !hasNoProjects && Boolean(currentProjectId)}
					agentSectionContent={homeSidebarAgentPanel}
					agentSectionSummary={homeSidebarAgentSummary}
					onSelectAllProjects={() => {
						setDetailOrigin("project");
						handleSelectAllProjects();
					}}
					onSelectProject={(projectId) => {
						setDetailOrigin("project");
						void handleSelectProject(projectId);
					}}
					onRemoveProject={handleRemoveProject}
					onAddProject={() => {
						void handleAddProject();
					}}
				/>
			) : null}
			<div className="flex flex-col flex-1 min-w-0 overflow-hidden">
				<TopBar
					onBack={selectedCard ? handleBack : undefined}
					workspacePath={navbarWorkspacePath}
					isWorkspacePathLoading={shouldShowProjectLoadingStateWithCache}
					workspaceHint={navbarWorkspaceHint}
					runtimeHint={navbarRuntimeHint}
					selectedTaskId={selectedCard?.card.id ?? null}
					selectedTaskBaseRef={selectedCard?.card.baseRef ?? null}
					showHomeGitSummary={!isAggregateView && !hasNoProjects && !selectedCard}
					runningGitAction={selectedCard || hasNoProjects || isAggregateView ? null : runningGitAction}
					onGitFetch={
						selectedCard || isAggregateView
							? undefined
							: () => {
									void runGitAction("fetch");
								}
					}
					onGitPull={
						selectedCard || isAggregateView
							? undefined
							: () => {
									void runGitAction("pull");
								}
					}
					onGitPush={
						selectedCard || isAggregateView
							? undefined
							: () => {
									void runGitAction("push");
								}
					}
					onToggleTerminal={
						hasNoProjects || isAggregateView
							? undefined
							: selectedCard
								? handleToggleDetailTerminal
								: handleToggleHomeTerminal
					}
					isTerminalOpen={isAggregateView ? false : selectedCard ? isDetailTerminalOpen : showHomeBottomTerminal}
					isTerminalLoading={
						isAggregateView ? false : selectedCard ? isDetailTerminalStarting : isHomeTerminalStarting
					}
					onOpenSettings={handleOpenSettings}
					onOpenSupervisor={currentProjectId ? handleOpenSupervisorPanel : undefined}
					supervisorPendingCount={approvalQueuePending.length}
					showDebugButton={debugModeEnabled}
					onOpenDebugDialog={debugModeEnabled ? handleOpenDebugDialog : undefined}
					shortcuts={isAggregateView ? [] : shortcuts}
					selectedShortcutLabel={selectedShortcutLabel}
					onSelectShortcutLabel={handleSelectShortcutLabel}
					runningShortcutLabel={runningShortcutLabel}
					onRunShortcut={isAggregateView ? undefined : handleRunShortcut}
					onCreateFirstShortcut={isAggregateView ? undefined : currentProjectId ? handleCreateShortcut : undefined}
					openTargetOptions={openTargetOptions}
					selectedOpenTargetId={selectedOpenTargetId}
					onSelectOpenTarget={onSelectOpenTarget}
					onOpenWorkspace={onOpenWorkspace}
					canOpenWorkspace={canOpenWorkspace}
					isOpeningWorkspace={isOpeningWorkspace}
					onToggleGitHistory={hasNoProjects || isAggregateView ? undefined : handleToggleGitHistory}
					isGitHistoryOpen={isAggregateView ? false : isGitHistoryOpen}
					hideProjectDependentActions={shouldHideProjectDependentTopBarActions}
				/>
				<div className="relative flex flex-1 min-h-0 min-w-0 overflow-hidden">
					<div
						className="kb-home-layout"
						aria-hidden={selectedCard ? true : undefined}
						style={selectedCard ? { visibility: "hidden" } : undefined}
					>
						{shouldShowProjectLoadingStateWithCache ? (
							<div className="flex flex-1 min-h-0 items-center justify-center bg-surface-0">
								<Spinner size={30} />
							</div>
						) : hasNoProjects ? (
							<div className="flex flex-1 min-h-0 items-center justify-center bg-surface-0 p-6">
								<div className="flex flex-col items-center justify-center gap-3 text-text-tertiary">
									<FolderOpen size={48} strokeWidth={1} />
									<h3 className="text-sm font-semibold text-text-primary">No projects yet</h3>
									<p className="text-[13px] text-text-secondary">
										Add a git repository to start using FS Kanban.
									</p>
									<Button
										variant="primary"
										onClick={() => {
											void handleAddProject();
										}}
									>
										Add Project
									</Button>
								</div>
							</div>
						) : (
							<div className="flex flex-1 flex-col min-h-0 min-w-0">
								<div className="flex flex-1 min-h-0 min-w-0">
									{isAggregateView ? (
										!hasReceivedAggregateSnapshot && !aggregateStreamError ? (
											<div className="flex flex-1 min-h-0 items-center justify-center bg-surface-0">
												<Spinner size={30} />
											</div>
										) : (
											<ActiveProjectsBoard
												data={aggregateBoard}
												onCardSelect={handleAggregateCardSelect}
												onCommitTask={handleAggregateCommitTask}
												onOpenPrTask={handleAggregateOpenPrTask}
												onMoveToTrashTask={handleAggregateMoveToTrashTask}
												onCancelAutomaticTaskAction={handleAggregateCancelAutomaticTaskAction}
												commitTaskLoadingById={aggregateCommitTaskLoadingById}
												openPrTaskLoadingById={aggregateOpenPrTaskLoadingById}
												moveToTrashLoadingById={aggregateMoveToTrashLoadingById}
											/>
										)
									) : isGitHistoryOpen ? (
										<GitHistoryView
											workspaceId={currentProjectId}
											gitHistory={gitHistory}
											onCheckoutBranch={(branch) => {
												void switchHomeBranch(branch);
											}}
											onDiscardWorkingChanges={() => {
												void discardHomeWorkingChanges();
											}}
											isDiscardWorkingChangesPending={isDiscardingHomeWorkingChanges}
										/>
									) : (
										<div
											className="flex flex-1 min-h-0 min-w-0"
											style={isProjectSwitching ? { pointerEvents: "none" } : undefined}
										>
											<KanbanBoard
												data={displayedBoard}
												taskSessions={displayedSessions}
												workspacePath={displayedWorkspacePath}
												onCardSelect={handleCardSelect}
												onCreateTask={handleOpenCreateTask}
												onStartTask={handleStartTaskFromBoard}
												onStartAllTasks={handleStartAllBacklogTasksFromBoard}
												onRunBacklogCleanup={handleRunBacklogCleanup}
												onRestartBoardAgent={handleRestartBoardAgent}
												onClearTrash={handleOpenClearTrash}
												editingTaskId={editingTaskId}
												inlineTaskEditor={inlineTaskEditor}
												onEditTask={handleOpenEditTask}
												onCommitTask={handleCommitTask}
												onOpenPrTask={handleOpenPrTask}
												onCancelAutomaticTaskAction={handleCancelAutomaticTaskAction}
												commitTaskLoadingById={commitTaskLoadingById}
												openPrTaskLoadingById={openPrTaskLoadingById}
												moveToTrashLoadingById={moveToTrashLoadingById}
												onMoveToTrashTask={handleMoveReviewCardToTrash}
												onRestoreFromTrashTask={handleRestoreTaskFromTrash}
												dependencies={displayedBoard.dependencies}
												onCreateDependency={handleCreateDependency}
												onDeleteDependency={handleDeleteDependency}
												onRequestProgrammaticCardMoveReady={
													selectedCard ? undefined : handleProgrammaticCardMoveReady
												}
												onDragEnd={handleDragEnd}
											/>
										</div>
									)}
								</div>
								{!isAggregateView && showHomeBottomTerminal ? (
									<ResizableBottomPane
										minHeight={200}
										initialHeight={homeTerminalPaneHeight}
										onHeightChange={setHomeTerminalPaneHeight}
									>
										<div
											style={{
												display: "flex",
												flex: "1 1 0",
												minWidth: 0,
												paddingLeft: 12,
												paddingRight: 12,
											}}
										>
											<AgentTerminalPanel
												key={`home-shell-${homeTerminalTaskId}`}
												taskId={homeTerminalTaskId}
												workspaceId={currentProjectId}
												summary={homeTerminalSummary}
												onSummary={upsertSession}
												showSessionToolbar={false}
												autoFocus
												onClose={closeHomeTerminal}
												minimalHeaderTitle="Terminal"
												minimalHeaderSubtitle={homeTerminalSubtitle}
												panelBackgroundColor={TERMINAL_THEME_COLORS.surfaceRaised}
												terminalBackgroundColor={TERMINAL_THEME_COLORS.surfaceRaised}
												cursorColor={TERMINAL_THEME_COLORS.textPrimary}
												showRightBorder={false}
												onConnectionReady={markTerminalConnectionReady}
												agentCommand={agentCommand}
												onSendAgentCommand={handleSendAgentCommandToHomeTerminal}
												isExpanded={isHomeTerminalExpanded}
												onToggleExpand={handleToggleExpandHomeTerminal}
											/>
										</div>
									</ResizableBottomPane>
								) : null}
							</div>
						)}
					</div>
					{selectedCard && detailSession ? (
						<div className="absolute inset-0 flex min-h-0 min-w-0">
							<CardDetailView
								selection={selectedCard}
								currentProjectId={currentProjectId}
								runtimeConfig={runtimeProjectConfig ?? null}
								workspacePath={workspacePath}
								sessionSummary={detailSession}
								taskSessions={sessions}
								onSessionSummary={upsertSession}
								onCardSelect={handleCardSelect}
								onTaskDragEnd={handleDetailTaskDragEnd}
								onCreateTask={handleOpenCreateTask}
								onStartTask={handleStartTaskFromBoard}
								onStartAllTasks={handleStartAllBacklogTasksFromBoard}
								onRunBacklogCleanup={handleRunBacklogCleanup}
								onRestartBoardAgent={handleRestartBoardAgent}
								onClearTrash={handleOpenClearTrash}
								editingTaskId={editingTaskId}
								inlineTaskEditor={inlineTaskEditor}
								onEditTask={(task) => {
									handleOpenEditTask(task, { preserveDetailSelection: true });
								}}
								onCommitTask={handleCommitTask}
								onOpenPrTask={handleOpenPrTask}
								onAgentCommitTask={handleAgentCommitTask}
								onAgentOpenPrTask={handleAgentOpenPrTask}
								commitTaskLoadingById={commitTaskLoadingById}
								openPrTaskLoadingById={openPrTaskLoadingById}
								agentCommitTaskLoadingById={agentCommitTaskLoadingById}
								agentOpenPrTaskLoadingById={agentOpenPrTaskLoadingById}
								moveToTrashLoadingById={moveToTrashLoadingById}
								onMoveReviewCardToTrash={handleMoveReviewCardToTrash}
								onRestoreTaskFromTrash={handleRestoreTaskFromTrash}
								onRetryTaskWithAgent={handleRetryTaskWithAgent}
								onCancelAutomaticTaskAction={handleCancelAutomaticTaskAction}
								onAddReviewComments={(taskId: string, text: string) => {
									void handleAddReviewComments(taskId, text);
								}}
								onSendReviewComments={(taskId: string, text: string) => {
									void handleSendReviewComments(taskId, text);
								}}
								onMoveToTrash={handleMoveToTrash}
								isMoveToTrashLoading={moveToTrashLoadingById[selectedCard.card.id] ?? false}
								sidebarPanel={aggregateDetailSidebarPanel}
								gitHistoryPanel={
									isGitHistoryOpen ? (
										<GitHistoryView workspaceId={currentProjectId} gitHistory={gitHistory} />
									) : undefined
								}
								onCloseGitHistory={handleCloseGitHistory}
								bottomTerminalOpen={isDetailTerminalOpen}
								bottomTerminalTaskId={detailTerminalTaskId}
								bottomTerminalSummary={detailTerminalSummary}
								bottomTerminalSubtitle={detailTerminalSubtitle}
								onBottomTerminalClose={closeDetailTerminal}
								bottomTerminalPaneHeight={detailTerminalPaneHeight}
								onBottomTerminalPaneHeightChange={setDetailTerminalPaneHeight}
								onBottomTerminalConnectionReady={markTerminalConnectionReady}
								bottomTerminalAgentCommand={agentCommand}
								onBottomTerminalSendAgentCommand={handleSendAgentCommandToDetailTerminal}
								isBottomTerminalExpanded={isDetailTerminalExpanded}
								onBottomTerminalToggleExpand={handleToggleExpandDetailTerminal}
								isDocumentVisible={isDocumentVisible}
							/>
						</div>
					) : null}
				</div>
			</div>
			<RuntimeSettingsDialog
				open={isSettingsOpen}
				workspaceId={settingsWorkspaceId}
				initialConfig={settingsRuntimeProjectConfig}
				initialSection={settingsInitialSection}
				onOpenChange={(nextOpen) => {
					setIsSettingsOpen(nextOpen);
					if (!nextOpen) {
						setSettingsInitialSection(null);
					}
				}}
				onSaved={() => {
					refreshRuntimeProjectConfig();
					refreshSettingsRuntimeProjectConfig();
				}}
			/>
			<Dialog open={isSupervisorPanelOpen} onOpenChange={setIsSupervisorPanelOpen}>
				<DialogHeader title="Supervisor" />
				<DialogBody>
					<SupervisorPanel
						pending={approvalQueuePending}
						recent={approvalQueueRecent}
						onDecide={handleSupervisorDecision}
					/>
				</DialogBody>
			</Dialog>
			<DebugDialog
				open={isDebugDialogOpen}
				onOpenChange={handleDebugDialogOpenChange}
				isResetAllStatePending={isResetAllStatePending}
				onShowStartupOnboardingDialog={handleShowStartupOnboardingDialog}
				onResetAllState={handleResetAllState}
			/>
			<TaskCreateDialog
				open={isInlineTaskCreateOpen}
				onOpenChange={handleCreateDialogOpenChange}
				prompt={newTaskPrompt}
				onPromptChange={setNewTaskPrompt}
				attachments={newTaskAttachments}
				onAttachmentsChange={setNewTaskAttachments}
				onCreate={handleCreateTask}
				onCreateAndStart={handleCreateAndStartTask}
				onCreateStartAndOpen={handleCreateStartAndOpenTask}
				onCreateMultiple={handleCreateTasks}
				onCreateAndStartMultiple={handleCreateAndStartTasks}
				startInPlanMode={newTaskStartInPlanMode}
				onStartInPlanModeChange={setNewTaskStartInPlanMode}
				startInPlanModeDisabled={isNewTaskStartInPlanModeDisabled}
				autoReviewEnabled={newTaskAutoReviewEnabled}
				onAutoReviewEnabledChange={setNewTaskAutoReviewEnabled}
				autoReviewMode={newTaskAutoReviewMode}
				onAutoReviewModeChange={setNewTaskAutoReviewMode}
				workspaceId={currentProjectId}
				runtimeConfig={runtimeProjectConfig ?? null}
				branchRef={newTaskBranchRef}
				branchOptions={createTaskBranchOptions}
				onBranchRefChange={setNewTaskBranchRef}
				agentPreference={newTaskAgentPreference}
				onAgentPreferenceChange={setNewTaskAgentPreference}
				fallbackAgentPreference={newTaskFallbackAgentPreference}
				onFallbackAgentPreferenceChange={setNewTaskFallbackAgentPreference}
			/>
			<ClearTrashDialog
				open={isClearTrashDialogOpen}
				taskCount={trashTaskCount}
				onCancel={() => setIsClearTrashDialogOpen(false)}
				onConfirm={handleConfirmClearTrash}
			/>
			<StartupOnboardingDialog
				open={isStartupOnboardingDialogOpen}
				onClose={handleCloseStartupOnboardingDialog}
				selectedAgentId={runtimeProjectConfig?.selectedAgentId ?? null}
				agents={runtimeProjectConfig?.agents ?? []}
				workspaceId={currentProjectId}
				runtimeConfig={runtimeProjectConfig ?? null}
				onSelectAgent={handleSelectOnboardingAgent}
				onAgentSetupSaved={handleOnboardingAgentSetupSaved}
			/>

			<AlertDialog
				open={pendingGitInitializationPath !== null}
				onOpenChange={(open) => {
					if (!open) {
						handleCancelInitializeGitProject();
					}
				}}
			>
				<AlertDialogHeader>
					<AlertDialogTitle>Initialize git repository?</AlertDialogTitle>
				</AlertDialogHeader>
				<AlertDialogBody>
					<AlertDialogDescription asChild>
						<div className="flex flex-col gap-3">
							<p>
								FS Kanban requires git to manage worktrees for tasks. This folder is not a git repository yet.
							</p>
							{pendingGitInitializationPath ? (
								<p className="font-mono text-xs text-text-secondary break-all">
									{pendingGitInitializationPath}
								</p>
							) : null}
							<p>If you cancel, the project will not be added.</p>
						</div>
					</AlertDialogDescription>
				</AlertDialogBody>
				<AlertDialogFooter>
					<AlertDialogCancel asChild>
						<Button
							variant="default"
							disabled={isInitializingGitProject}
							onClick={handleCancelInitializeGitProject}
						>
							Cancel
						</Button>
					</AlertDialogCancel>
					<AlertDialogAction asChild>
						<Button
							variant="primary"
							disabled={isInitializingGitProject}
							onClick={() => {
								void handleConfirmInitializeGitProject();
							}}
						>
							{isInitializingGitProject ? (
								<>
									<Spinner size={14} />
									Initializing...
								</>
							) : (
								"Initialize git"
							)}
						</Button>
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialog>

			<AlertDialog
				open={gitActionError !== null}
				onOpenChange={(open) => {
					if (!open) {
						clearGitActionError();
					}
				}}
			>
				<AlertDialogHeader>
					<AlertDialogTitle>{gitActionErrorTitle}</AlertDialogTitle>
				</AlertDialogHeader>
				<AlertDialogBody>
					<p>{gitActionError?.message}</p>
					{gitActionError?.output ? (
						<pre className="max-h-[220px] overflow-auto rounded-md bg-surface-0 p-3 font-mono text-xs text-text-secondary whitespace-pre-wrap">
							{gitActionError.output}
						</pre>
					) : null}
				</AlertDialogBody>
				<AlertDialogFooter className="justify-end">
					<AlertDialogAction asChild>
						<Button variant="default" onClick={clearGitActionError}>
							Close
						</Button>
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialog>
		</div>
	);
}
