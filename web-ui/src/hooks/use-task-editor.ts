import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
	normalizeStoredTaskAutoReviewMode,
	TASK_AUTO_REVIEW_ENABLED_STORAGE_KEY,
	TASK_AUTO_REVIEW_MODE_STORAGE_KEY,
	TASK_START_IN_PLAN_MODE_STORAGE_KEY,
} from "@/hooks/app-utils";
import type { RuntimeConfigResponse } from "@/runtime/types";
import { addTaskToColumnWithResult, findCardSelection, updateTask } from "@/state/board-state";
import type { BoardCard, BoardData, TaskAttachment, TaskAutoReviewMode, TaskImage } from "@/types";
import { resolveTaskAutoReviewMode } from "@/types";
import { useBooleanLocalStorageValue, useRawLocalStorageValue } from "@/utils/react-use";
import {
	fromTaskAgentPreferenceValue,
	fromTaskFallbackAgentPreferenceValue,
	toTaskAgentPreferenceValue,
	toTaskFallbackAgentPreferenceValue,
	type TaskAgentPreferenceValue,
	type TaskFallbackAgentPreferenceValue,
} from "@/utils/task-agent-preferences";

interface UseTaskEditorInput {
	board: BoardData;
	setBoard: Dispatch<SetStateAction<BoardData>>;
	currentProjectId: string | null;
	createTaskBranchOptions: Array<{ value: string; label: string }>;
	defaultTaskBranchRef: string;
	runtimeConfig?: RuntimeConfigResponse | null;
	setSelectedTaskId: Dispatch<SetStateAction<string | null>>;
	queueTaskStartAfterEdit?: (taskId: string) => void;
}

interface OpenEditTaskOptions {
	preserveDetailSelection?: boolean;
}

interface CreateTaskOptions {
	keepDialogOpen?: boolean;
}

export interface UseTaskEditorResult {
	isInlineTaskCreateOpen: boolean;
	newTaskPrompt: string;
	setNewTaskPrompt: Dispatch<SetStateAction<string>>;
	newTaskAttachments: TaskAttachment[];
	setNewTaskAttachments: Dispatch<SetStateAction<TaskAttachment[]>>;
	newTaskStartInPlanMode: boolean;
	setNewTaskStartInPlanMode: Dispatch<SetStateAction<boolean>>;
	newTaskAutoReviewEnabled: boolean;
	setNewTaskAutoReviewEnabled: Dispatch<SetStateAction<boolean>>;
	newTaskAutoReviewMode: TaskAutoReviewMode;
	setNewTaskAutoReviewMode: Dispatch<SetStateAction<TaskAutoReviewMode>>;
	isNewTaskStartInPlanModeDisabled: boolean;
	newTaskBranchRef: string;
	setNewTaskBranchRef: Dispatch<SetStateAction<string>>;
	newTaskAgentPreference: TaskAgentPreferenceValue;
	setNewTaskAgentPreference: Dispatch<SetStateAction<TaskAgentPreferenceValue>>;
	newTaskFallbackAgentPreference: TaskFallbackAgentPreferenceValue;
	setNewTaskFallbackAgentPreference: Dispatch<SetStateAction<TaskFallbackAgentPreferenceValue>>;
	editingTaskId: string | null;
	editTaskPrompt: string;
	setEditTaskPrompt: Dispatch<SetStateAction<string>>;
	editTaskAttachments: TaskAttachment[];
	setEditTaskAttachments: Dispatch<SetStateAction<TaskAttachment[]>>;
	editTaskStartInPlanMode: boolean;
	setEditTaskStartInPlanMode: Dispatch<SetStateAction<boolean>>;
	editTaskAutoReviewEnabled: boolean;
	setEditTaskAutoReviewEnabled: Dispatch<SetStateAction<boolean>>;
	editTaskAutoReviewMode: TaskAutoReviewMode;
	setEditTaskAutoReviewMode: Dispatch<SetStateAction<TaskAutoReviewMode>>;
	isEditTaskStartInPlanModeDisabled: boolean;
	editTaskBranchRef: string;
	setEditTaskBranchRef: Dispatch<SetStateAction<string>>;
	editTaskAgentPreference: TaskAgentPreferenceValue;
	setEditTaskAgentPreference: Dispatch<SetStateAction<TaskAgentPreferenceValue>>;
	editTaskFallbackAgentPreference: TaskFallbackAgentPreferenceValue;
	setEditTaskFallbackAgentPreference: Dispatch<SetStateAction<TaskFallbackAgentPreferenceValue>>;
	handleOpenCreateTask: () => void;
	handleCancelCreateTask: () => void;
	handleOpenEditTask: (task: BoardCard, options?: OpenEditTaskOptions) => void;
	handleCancelEditTask: () => void;
	handleSaveEditedTask: () => string | null;
	handleSaveAndStartEditedTask: () => void;
	handleCreateTask: (options?: CreateTaskOptions) => string | null;
	handleCreateTasks: (prompts: string[], options?: CreateTaskOptions) => string[];
	resetTaskEditorState: () => void;
}

export function useTaskEditor({
	board,
	setBoard,
	currentProjectId,
	createTaskBranchOptions,
	defaultTaskBranchRef,
	runtimeConfig: _runtimeConfig,
	setSelectedTaskId,
	queueTaskStartAfterEdit,
}: UseTaskEditorInput): UseTaskEditorResult {
	const [isInlineTaskCreateOpen, setIsInlineTaskCreateOpen] = useState(false);
	const [newTaskPrompt, setNewTaskPrompt] = useState("");
	const [newTaskAttachments, setNewTaskAttachments] = useState<TaskAttachment[]>([]);
	const [newTaskStartInPlanMode, setNewTaskStartInPlanMode] = useBooleanLocalStorageValue(
		TASK_START_IN_PLAN_MODE_STORAGE_KEY,
		false,
	);
	const [newTaskAutoReviewEnabled, setNewTaskAutoReviewEnabled] = useBooleanLocalStorageValue(
		TASK_AUTO_REVIEW_ENABLED_STORAGE_KEY,
		false,
	);
	const [newTaskAutoReviewMode, setNewTaskAutoReviewMode] = useRawLocalStorageValue<TaskAutoReviewMode>(
		TASK_AUTO_REVIEW_MODE_STORAGE_KEY,
		"commit",
		normalizeStoredTaskAutoReviewMode,
	);
	const [newTaskAgentPreference, setNewTaskAgentPreference] = useState<TaskAgentPreferenceValue>("inherit");
	const [newTaskFallbackAgentPreference, setNewTaskFallbackAgentPreference] =
		useState<TaskFallbackAgentPreferenceValue>("inherit");
	const isNewTaskStartInPlanModeDisabled = newTaskAutoReviewEnabled && newTaskAutoReviewMode === "move_to_trash";
	const [newTaskBranchRef, setNewTaskBranchRef] = useState("");
	const [lastCreatedTaskBranchByProjectId, setLastCreatedTaskBranchByProjectId] = useState<Record<string, string>>({});
	const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
	const [editTaskPrompt, setEditTaskPrompt] = useState("");
	const [editTaskAttachments, setEditTaskAttachments] = useState<TaskAttachment[]>([]);
	const [editTaskLegacyImages, setEditTaskLegacyImages] = useState<TaskImage[]>([]);
	const [editTaskStartInPlanMode, setEditTaskStartInPlanMode] = useState(false);
	const [editTaskAutoReviewEnabled, setEditTaskAutoReviewEnabled] = useState(false);
	const [editTaskAutoReviewMode, setEditTaskAutoReviewMode] = useState<TaskAutoReviewMode>("commit");
	const [editTaskAgentPreference, setEditTaskAgentPreference] = useState<TaskAgentPreferenceValue>("inherit");
	const [editTaskFallbackAgentPreference, setEditTaskFallbackAgentPreference] =
		useState<TaskFallbackAgentPreferenceValue>("inherit");
	const isEditTaskStartInPlanModeDisabled = editTaskAutoReviewEnabled && editTaskAutoReviewMode === "move_to_trash";
	const [editTaskBranchRef, setEditTaskBranchRef] = useState("");

	const lastCreatedTaskBranchRef = useMemo(() => {
		if (!currentProjectId) {
			return null;
		}
		return lastCreatedTaskBranchByProjectId[currentProjectId] ?? null;
	}, [currentProjectId, lastCreatedTaskBranchByProjectId]);

	const resolvedDefaultTaskBranchRef = useMemo(() => {
		if (
			lastCreatedTaskBranchRef &&
			createTaskBranchOptions.some((option) => option.value === lastCreatedTaskBranchRef)
		) {
			return lastCreatedTaskBranchRef;
		}
		return defaultTaskBranchRef;
	}, [createTaskBranchOptions, defaultTaskBranchRef, lastCreatedTaskBranchRef]);

	useEffect(() => {
		const isCurrentValid = createTaskBranchOptions.some((option) => option.value === newTaskBranchRef);
		if (isCurrentValid) {
			return;
		}
		setNewTaskBranchRef(resolvedDefaultTaskBranchRef);
	}, [createTaskBranchOptions, newTaskBranchRef, resolvedDefaultTaskBranchRef]);

	useEffect(() => {
		if (!isInlineTaskCreateOpen) {
			return;
		}
		if (!newTaskBranchRef) {
			setNewTaskBranchRef(resolvedDefaultTaskBranchRef);
		}
	}, [isInlineTaskCreateOpen, newTaskBranchRef, resolvedDefaultTaskBranchRef]);

	useEffect(() => {
		if (!isNewTaskStartInPlanModeDisabled || !newTaskStartInPlanMode) {
			return;
		}
		setNewTaskStartInPlanMode(false);
	}, [isNewTaskStartInPlanModeDisabled, newTaskStartInPlanMode, setNewTaskStartInPlanMode]);

	useEffect(() => {
		if (!isEditTaskStartInPlanModeDisabled || !editTaskStartInPlanMode) {
			return;
		}
		setEditTaskStartInPlanMode(false);
	}, [editTaskStartInPlanMode, isEditTaskStartInPlanModeDisabled]);

	useEffect(() => {
		if (!editingTaskId) {
			return;
		}
		const isCurrentValid = createTaskBranchOptions.some((option) => option.value === editTaskBranchRef);
		if (isCurrentValid) {
			return;
		}
		setEditTaskBranchRef(resolvedDefaultTaskBranchRef);
	}, [createTaskBranchOptions, editTaskBranchRef, editingTaskId, resolvedDefaultTaskBranchRef]);

	useEffect(() => {
		if (!editingTaskId) {
			return;
		}
		const selection = findCardSelection(board, editingTaskId);
		if (!selection || selection.column.id !== "backlog") {
			setEditingTaskId(null);
			setEditTaskPrompt("");
			setEditTaskStartInPlanMode(false);
			setEditTaskAutoReviewEnabled(false);
			setEditTaskAutoReviewMode("commit");
			setEditTaskAgentPreference("inherit");
			setEditTaskFallbackAgentPreference("inherit");
			setEditTaskAttachments([]);
			setEditTaskLegacyImages([]);
			setEditTaskBranchRef("");
		}
	}, [board, editingTaskId]);

	const handleOpenCreateTask = useCallback(() => {
		setEditingTaskId(null);
		setEditTaskPrompt("");
		setEditTaskAttachments([]);
		setEditTaskLegacyImages([]);
		setEditTaskAgentPreference("inherit");
		setEditTaskFallbackAgentPreference("inherit");
		setIsInlineTaskCreateOpen(true);
	}, []);

	const handleCancelCreateTask = useCallback(() => {
		setIsInlineTaskCreateOpen(false);
		setNewTaskPrompt("");
		setNewTaskAttachments([]);
		setNewTaskAgentPreference("inherit");
		setNewTaskFallbackAgentPreference("inherit");
		setNewTaskBranchRef(resolvedDefaultTaskBranchRef);
	}, [resolvedDefaultTaskBranchRef]);

	const handleOpenEditTask = useCallback(
		(task: BoardCard, options?: OpenEditTaskOptions) => {
			if (!options?.preserveDetailSelection) {
				setSelectedTaskId(null);
			}
			setIsInlineTaskCreateOpen(false);
			setNewTaskPrompt("");
			setNewTaskAttachments([]);
			const taskPrompt = task.prompt.trim();
			setEditingTaskId(task.id);
			setEditTaskPrompt(taskPrompt);
			setEditTaskAttachments(task.attachments ? task.attachments.map((attachment) => ({ ...attachment })) : []);
			setEditTaskLegacyImages(task.images ? task.images.map((image) => ({ ...image })) : []);
			setEditTaskStartInPlanMode(task.startInPlanMode);
			setEditTaskAutoReviewEnabled(task.autoReviewEnabled === true);
			setEditTaskAutoReviewMode(resolveTaskAutoReviewMode(task.autoReviewMode));
			setEditTaskAgentPreference(toTaskAgentPreferenceValue(task.agentId));
			setEditTaskFallbackAgentPreference(toTaskFallbackAgentPreferenceValue(task.fallbackAgentId));
			const fallbackBranch = task.baseRef || resolvedDefaultTaskBranchRef;
			setEditTaskBranchRef(fallbackBranch);
		},
		[resolvedDefaultTaskBranchRef, setSelectedTaskId],
	);

	const handleCancelEditTask = useCallback(() => {
		setEditingTaskId(null);
		setEditTaskPrompt("");
		setEditTaskStartInPlanMode(false);
		setEditTaskAutoReviewEnabled(false);
		setEditTaskAutoReviewMode("commit");
		setEditTaskAgentPreference("inherit");
		setEditTaskFallbackAgentPreference("inherit");
		setEditTaskAttachments([]);
		setEditTaskLegacyImages([]);
		setEditTaskBranchRef("");
	}, []);

	const handleSaveEditedTask = useCallback((): string | null => {
		if (!editingTaskId) {
			return null;
		}
		const prompt = editTaskPrompt.trim();
		if (!prompt) {
			return null;
		}
		if (!(editTaskBranchRef || resolvedDefaultTaskBranchRef)) {
			return null;
		}

		const baseRef = editTaskBranchRef || resolvedDefaultTaskBranchRef;
		const savedTaskId = editingTaskId;
		const remainingLegacyImages = editTaskLegacyImages.filter((image) =>
			editTaskAttachments.some((attachment) => attachment.id === image.id),
		);

		setBoard((currentBoard) => {
			const updated = updateTask(currentBoard, savedTaskId, {
				prompt,
				startInPlanMode: editTaskStartInPlanMode,
				autoReviewEnabled: editTaskAutoReviewEnabled,
				autoReviewMode: editTaskAutoReviewMode,
				attachments: editTaskAttachments,
				images: remainingLegacyImages,
				agentId: fromTaskAgentPreferenceValue(editTaskAgentPreference),
				fallbackAgentId: fromTaskFallbackAgentPreferenceValue(editTaskFallbackAgentPreference),
				baseRef,
			});
			return updated.updated ? updated.board : currentBoard;
		});
		setEditingTaskId(null);
		setEditTaskPrompt("");
		setEditTaskAutoReviewEnabled(false);
		setEditTaskAutoReviewMode("commit");
		setEditTaskAgentPreference("inherit");
		setEditTaskFallbackAgentPreference("inherit");
		setEditTaskAttachments([]);
		setEditTaskLegacyImages([]);
		return savedTaskId;
	}, [
		editTaskAgentPreference,
		editTaskAutoReviewEnabled,
		editTaskAutoReviewMode,
		editTaskBranchRef,
		editTaskFallbackAgentPreference,
		editTaskPrompt,
		editTaskAttachments,
		editTaskLegacyImages,
		editTaskStartInPlanMode,
		editingTaskId,
		resolvedDefaultTaskBranchRef,
		setBoard,
	]);

	const handleSaveAndStartEditedTask = useCallback(() => {
		const taskId = handleSaveEditedTask();
		if (!taskId) {
			return;
		}
		queueTaskStartAfterEdit?.(taskId);
	}, [handleSaveEditedTask, queueTaskStartAfterEdit]);

	const handleCreateTask = useCallback((options?: CreateTaskOptions): string | null => {
		const prompt = newTaskPrompt.trim();
		if (!prompt) {
			return null;
		}
		if (!(newTaskBranchRef || resolvedDefaultTaskBranchRef)) {
			return null;
		}
		const baseRef = newTaskBranchRef || resolvedDefaultTaskBranchRef;
		const created = addTaskToColumnWithResult(board, "backlog", {
			prompt,
			startInPlanMode: newTaskStartInPlanMode,
			autoReviewEnabled: newTaskAutoReviewEnabled,
			autoReviewMode: newTaskAutoReviewMode,
			attachments: newTaskAttachments,
			agentId: fromTaskAgentPreferenceValue(newTaskAgentPreference),
			fallbackAgentId: fromTaskFallbackAgentPreferenceValue(newTaskFallbackAgentPreference),
			baseRef,
		});
		setBoard(created.board);
		if (currentProjectId) {
			setLastCreatedTaskBranchByProjectId((current) => ({
				...current,
				[currentProjectId]: baseRef,
			}));
		}
		setNewTaskPrompt("");
		setNewTaskAttachments([]);
		setNewTaskAgentPreference("inherit");
		setNewTaskFallbackAgentPreference("inherit");
		setNewTaskBranchRef(baseRef);
		if (!options?.keepDialogOpen) {
			setIsInlineTaskCreateOpen(false);
		}
		return created.task.id;
	}, [
		board,
		currentProjectId,
		newTaskAutoReviewEnabled,
		newTaskAutoReviewMode,
		newTaskAgentPreference,
		newTaskAttachments,
		newTaskBranchRef,
		newTaskFallbackAgentPreference,
		newTaskPrompt,
		newTaskStartInPlanMode,
		resolvedDefaultTaskBranchRef,
		setBoard,
	]);

	const handleCreateTasks = useCallback((prompts: string[], options?: CreateTaskOptions): string[] => {
		const validPrompts = prompts.map((p) => p.trim()).filter(Boolean);
		if (validPrompts.length === 0) {
			return [];
		}
		if (!(newTaskBranchRef || resolvedDefaultTaskBranchRef)) {
			return [];
		}
		const baseRef = newTaskBranchRef || resolvedDefaultTaskBranchRef;
		const createdTaskIds: string[] = [];
		let updatedBoard = board;
		for (const prompt of validPrompts) {
			const created = addTaskToColumnWithResult(updatedBoard, "backlog", {
				prompt,
				startInPlanMode: newTaskStartInPlanMode,
				autoReviewEnabled: newTaskAutoReviewEnabled,
				autoReviewMode: newTaskAutoReviewMode,
				attachments: newTaskAttachments,
				agentId: fromTaskAgentPreferenceValue(newTaskAgentPreference),
				fallbackAgentId: fromTaskFallbackAgentPreferenceValue(newTaskFallbackAgentPreference),
				baseRef,
			});
			updatedBoard = created.board;
			createdTaskIds.push(created.task.id);
		}
		setBoard(updatedBoard);
		if (currentProjectId) {
			setLastCreatedTaskBranchByProjectId((current) => ({
				...current,
				[currentProjectId]: baseRef,
			}));
		}
		setNewTaskPrompt("");
		setNewTaskAttachments([]);
		setNewTaskAgentPreference("inherit");
		setNewTaskFallbackAgentPreference("inherit");
		setNewTaskBranchRef(baseRef);
		if (!options?.keepDialogOpen) {
			setIsInlineTaskCreateOpen(false);
		}
		return createdTaskIds;
	}, [
		board,
		currentProjectId,
		newTaskAutoReviewEnabled,
		newTaskAutoReviewMode,
		newTaskAgentPreference,
		newTaskAttachments,
		newTaskBranchRef,
		newTaskFallbackAgentPreference,
		newTaskStartInPlanMode,
		resolvedDefaultTaskBranchRef,
		setBoard,
	]);

	const resetTaskEditorState = useCallback(() => {
		setIsInlineTaskCreateOpen(false);
		setEditingTaskId(null);
		setEditTaskPrompt("");
		setEditTaskStartInPlanMode(false);
		setEditTaskAutoReviewEnabled(false);
		setEditTaskAutoReviewMode("commit");
		setEditTaskAgentPreference("inherit");
		setEditTaskFallbackAgentPreference("inherit");
		setEditTaskAttachments([]);
		setEditTaskLegacyImages([]);
		setEditTaskBranchRef("");
		setNewTaskAttachments([]);
		setNewTaskAgentPreference("inherit");
		setNewTaskFallbackAgentPreference("inherit");
	}, []);

	return {
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
	};
}
