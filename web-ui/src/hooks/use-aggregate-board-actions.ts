import { useCallback, useMemo, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import type { TaskGitAction } from "@/git-actions/build-task-git-action-prompt";
import { buildTaskGitActionPrompt } from "@/git-actions/build-task-git-action-prompt";
import { getDetailTerminalTaskId } from "@/hooks/use-terminal-panels";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { fetchWorkspaceState, saveWorkspaceState } from "@/runtime/workspace-state-query";
import type { RuntimeAggregateBoardCard, RuntimeConfigResponse } from "@/runtime/types";
import { findCardSelection, trashTaskAndGetReadyLinkedTaskIds, updateTask } from "@/state/board-state";
import { resolveTaskAutoReviewMode } from "@/types";

function toWorkspaceInfo(card: RuntimeAggregateBoardCard) {
	const taskWorkspace = card.taskWorkspace;
	if (!taskWorkspace) {
		return null;
	}
	return {
		taskId: card.card.id,
		path: taskWorkspace.path,
		exists: taskWorkspace.exists,
		baseRef: card.card.baseRef,
		branch: taskWorkspace.branch,
		isDetached: taskWorkspace.isDetached,
		headCommit: taskWorkspace.headCommit,
	};
}

function toPromptTemplates(config: RuntimeConfigResponse | null) {
	if (!config) {
		return null;
	}
	return {
		commitPromptTemplate: config.commitPromptTemplate,
		openPrPromptTemplate: config.openPrPromptTemplate,
		commitPromptTemplateDefault: config.commitPromptTemplateDefault,
		openPrPromptTemplateDefault: config.openPrPromptTemplateDefault,
	};
}

export interface UseAggregateBoardActionsResult {
	commitTaskLoadingById: Record<string, boolean>;
	openPrTaskLoadingById: Record<string, boolean>;
	moveToTrashLoadingById: Record<string, boolean>;
	handleCommitTask: (card: RuntimeAggregateBoardCard) => void;
	handleOpenPrTask: (card: RuntimeAggregateBoardCard) => void;
	handleMoveToTrashTask: (card: RuntimeAggregateBoardCard) => void;
	handleCancelAutomaticTaskAction: (card: RuntimeAggregateBoardCard) => void;
}

export function useAggregateBoardActions(): UseAggregateBoardActionsResult {
	const [taskGitActionLoadingByKey, setTaskGitActionLoadingByKey] = useState<
		Record<string, { commit: boolean; pr: boolean }>
	>({});
	const [moveToTrashLoadingById, setMoveToTrashLoadingById] = useState<Record<string, boolean>>({});

	const setTaskGitActionLoading = useCallback((cardKey: string, action: TaskGitAction, isLoading: boolean) => {
		setTaskGitActionLoadingByKey((current) => {
			const existing = current[cardKey] ?? { commit: false, pr: false };
			const next = {
				...existing,
				[action]: isLoading,
			};
			if (!next.commit && !next.pr) {
				const { [cardKey]: _removed, ...rest } = current;
				return rest;
			}
			return {
				...current,
				[cardKey]: next,
			};
		});
	}, []);

	const runTaskGitAction = useCallback(
		async (card: RuntimeAggregateBoardCard, action: TaskGitAction) => {
			const workspaceInfo = toWorkspaceInfo(card);
			if (!workspaceInfo?.exists) {
				showAppToast({
					intent: "warning",
					icon: "warning-sign",
					message: "Task workspace is not available for this action.",
					timeout: 5000,
				});
				return;
			}
			setTaskGitActionLoading(card.key, action, true);
			try {
				const trpcClient = getRuntimeTrpcClient(card.workspaceId);
				const runtimeConfig = await trpcClient.runtime.getConfig.query();
				const prompt = buildTaskGitActionPrompt({
					action,
					workspaceInfo,
					templates: toPromptTemplates(runtimeConfig),
				});
				const typed = await trpcClient.runtime.sendTaskSessionInput.mutate({
					taskId: card.card.id,
					text: prompt,
					appendNewline: false,
				});
				if (!typed.ok) {
					showAppToast({
						intent: "danger",
						icon: "warning-sign",
						message: typed.error ?? "Could not send instructions to the task session.",
						timeout: 7000,
					});
					return;
				}
				await new Promise<void>((resolve) => {
					window.setTimeout(resolve, 200);
				});
				const submitted = await trpcClient.runtime.sendTaskSessionInput.mutate({
					taskId: card.card.id,
					text: "\r",
					appendNewline: false,
				});
				if (!submitted.ok) {
					showAppToast({
						intent: "danger",
						icon: "warning-sign",
						message: submitted.error ?? "Could not submit instructions to the task session.",
						timeout: 7000,
					});
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				showAppToast({
					intent: "danger",
					icon: "warning-sign",
					message,
					timeout: 7000,
				});
			} finally {
				setTaskGitActionLoading(card.key, action, false);
			}
		},
		[setTaskGitActionLoading],
	);

	const handleMoveToTrashTask = useCallback(async (card: RuntimeAggregateBoardCard) => {
		if (moveToTrashLoadingById[card.key]) {
			return;
		}
		setMoveToTrashLoadingById((current) => ({
			...current,
			[card.key]: true,
		}));
		try {
			const workspaceState = await fetchWorkspaceState(card.workspaceId);
			const trashed = trashTaskAndGetReadyLinkedTaskIds(workspaceState.board, card.card.id);
			if (trashed.moved) {
				await saveWorkspaceState(card.workspaceId, {
					board: trashed.board,
					sessions: workspaceState.sessions,
					expectedRevision: workspaceState.revision,
				});
			}
			const trpcClient = getRuntimeTrpcClient(card.workspaceId);
			await Promise.allSettled([
				trpcClient.runtime.stopTaskSession.mutate({ taskId: card.card.id }),
				trpcClient.runtime.stopTaskSession.mutate({ taskId: getDetailTerminalTaskId(card.card.id) }),
				trpcClient.workspace.deleteWorktree.mutate({ taskId: card.card.id }),
			]);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			showAppToast({
				intent: "danger",
				icon: "warning-sign",
				message,
				timeout: 7000,
			});
		} finally {
			setMoveToTrashLoadingById((current) => {
				const { [card.key]: _removed, ...rest } = current;
				return rest;
			});
		}
	}, [moveToTrashLoadingById]);

	const handleCancelAutomaticTaskAction = useCallback(async (card: RuntimeAggregateBoardCard) => {
		try {
			const workspaceState = await fetchWorkspaceState(card.workspaceId);
			const selection = findCardSelection(workspaceState.board, card.card.id);
			if (!selection || selection.card.autoReviewEnabled !== true) {
				return;
			}
			const updated = updateTask(workspaceState.board, card.card.id, {
				prompt: selection.card.prompt,
				startInPlanMode: selection.card.startInPlanMode,
				autoReviewEnabled: false,
				autoReviewMode: resolveTaskAutoReviewMode(selection.card.autoReviewMode),
				attachments: selection.card.attachments,
				images: selection.card.images,
				agentId: selection.card.agentId,
				fallbackAgentId: selection.card.fallbackAgentId,
				baseRef: selection.card.baseRef,
			});
			if (!updated.updated) {
				return;
			}
			await saveWorkspaceState(card.workspaceId, {
				board: updated.board,
				sessions: workspaceState.sessions,
				expectedRevision: workspaceState.revision,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			showAppToast({
				intent: "danger",
				icon: "warning-sign",
				message,
				timeout: 7000,
			});
		}
	}, []);

	const commitTaskLoadingById = useMemo(() => {
		const next: Record<string, boolean> = {};
		for (const [key, value] of Object.entries(taskGitActionLoadingByKey)) {
			if (value.commit) {
				next[key] = true;
			}
		}
		return next;
	}, [taskGitActionLoadingByKey]);

	const openPrTaskLoadingById = useMemo(() => {
		const next: Record<string, boolean> = {};
		for (const [key, value] of Object.entries(taskGitActionLoadingByKey)) {
			if (value.pr) {
				next[key] = true;
			}
		}
		return next;
	}, [taskGitActionLoadingByKey]);

	return {
		commitTaskLoadingById,
		openPrTaskLoadingById,
		moveToTrashLoadingById,
		handleCommitTask: (card) => {
			void runTaskGitAction(card, "commit");
		},
		handleOpenPrTask: (card) => {
			void runTaskGitAction(card, "pr");
		},
		handleMoveToTrashTask: (card) => {
			void handleMoveToTrashTask(card);
		},
		handleCancelAutomaticTaskAction: (card) => {
			void handleCancelAutomaticTaskAction(card);
		},
	};
}
