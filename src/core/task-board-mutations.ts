import type {
	RuntimeAgentId,
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeBoardDependency,
	RuntimeExternalTaskSource,
	RuntimeExternalTaskSourceInput,
	RuntimeTaskAttachment,
	RuntimeTaskAutoReviewMode,
	RuntimeTaskImage,
} from "./api-contract.js";
import { createUniqueTaskId } from "./task-id.js";

export interface RuntimeCreateTaskInput {
	prompt: string;
	startInPlanMode?: boolean;
	autoReviewEnabled?: boolean;
	autoReviewMode?: RuntimeTaskAutoReviewMode;
	attachments?: RuntimeTaskAttachment[];
	images?: RuntimeTaskImage[];
	agentId?: RuntimeAgentId;
	fallbackAgentId?: RuntimeAgentId | null;
	externalSource?: RuntimeExternalTaskSource;
	baseRef: string;
}

export interface RuntimeUpdateTaskInput {
	prompt: string;
	startInPlanMode?: boolean;
	autoReviewEnabled?: boolean;
	autoReviewMode?: RuntimeTaskAutoReviewMode;
	attachments?: RuntimeTaskAttachment[];
	images?: RuntimeTaskImage[];
	agentId?: RuntimeAgentId;
	fallbackAgentId?: RuntimeAgentId | null;
	externalSource?: RuntimeExternalTaskSource;
	baseRef: string;
}

export interface RuntimeImportBacklogTaskInput {
	prompt: string;
	baseRef: string;
	startInPlanMode?: boolean;
	autoReviewEnabled?: boolean;
	autoReviewMode?: RuntimeTaskAutoReviewMode;
	externalSource: RuntimeExternalTaskSourceInput;
}

function normalizeTaskAutoReviewMode(value: RuntimeTaskAutoReviewMode | null | undefined): RuntimeTaskAutoReviewMode {
	if (value === "pr" || value === "move_to_trash") {
		return value;
	}
	return "commit";
}

// Copy attachment metadata so board tasks do not retain caller-owned array or object references.
function cloneTaskAttachments(attachments?: RuntimeTaskAttachment[]): RuntimeTaskAttachment[] | undefined {
	return attachments && attachments.length > 0 ? attachments.map((attachment) => ({ ...attachment })) : undefined;
}

function cloneTaskImages(images?: RuntimeTaskImage[]): RuntimeTaskImage[] | undefined {
	return images && images.length > 0 ? images.map((image) => ({ ...image })) : undefined;
}

function detectAttachmentKindFromImage(image: RuntimeTaskImage): RuntimeTaskAttachment["kind"] {
	const normalizedMimeType = image.mimeType.trim().toLowerCase();
	if (normalizedMimeType.startsWith("image/")) {
		return "image";
	}
	return "other";
}

function estimateInlineImageSizeBytes(data: string): number {
	const normalized = data.trim();
	if (!normalized) {
		return 0;
	}
	const paddingLength = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor((normalized.length * 3) / 4) - paddingLength);
}

function attachmentsFromImages(images?: RuntimeTaskImage[]): RuntimeTaskAttachment[] | undefined {
	if (!images || images.length === 0) {
		return undefined;
	}
	return images.map((image, index) => ({
		id: image.id,
		kind: detectAttachmentKindFromImage(image),
		name: image.name?.trim() || `image-${index + 1}`,
		mimeType: image.mimeType,
		sizeBytes: estimateInlineImageSizeBytes(image.data),
		storageKey: "",
	}));
}

function normalizeTaskAgentId(agentId: RuntimeAgentId | null | undefined): RuntimeAgentId | undefined {
	return agentId === "claude" || agentId === "codex" ? agentId : undefined;
}

function normalizeTaskFallbackAgentId(
	agentId: RuntimeAgentId | null | undefined,
	preferredAgentId: RuntimeAgentId | undefined,
): RuntimeAgentId | null {
	if (agentId !== "claude" && agentId !== "codex") {
		return null;
	}
	return agentId === preferredAgentId ? null : agentId;
}

function cloneExternalTaskSource(source?: RuntimeExternalTaskSource): RuntimeExternalTaskSource | undefined {
	return source
		? {
				...source,
		  }
		: undefined;
}

function normalizeExternalTaskSource(
	source: RuntimeExternalTaskSourceInput,
	importedAt: number,
): RuntimeExternalTaskSource {
	return {
		provider: source.provider,
		externalId: source.externalId.trim(),
		externalUrl: source.externalUrl.trim(),
		repoKey: source.repoKey.trim(),
		itemType: source.itemType,
		sourceUpdatedAt: source.sourceUpdatedAt.trim(),
		importedAt,
	};
}

function externalTaskSourceMatches(
	cardSource: RuntimeExternalTaskSource | undefined,
	expected: RuntimeExternalTaskSourceInput,
): boolean {
	return (
		cardSource?.provider === expected.provider &&
		cardSource.externalId === expected.externalId.trim()
	);
}

function externalTaskSourceEquals(
	left: RuntimeExternalTaskSource | undefined,
	right: RuntimeExternalTaskSource | undefined,
): boolean {
	if (!left && !right) {
		return true;
	}
	if (!left || !right) {
		return false;
	}
	return (
		left.provider === right.provider &&
		left.externalId === right.externalId &&
		left.externalUrl === right.externalUrl &&
		left.repoKey === right.repoKey &&
		left.itemType === right.itemType &&
		left.sourceUpdatedAt === right.sourceUpdatedAt &&
		left.importedAt === right.importedAt
	);
}

export interface RuntimeCreateTaskResult {
	board: RuntimeBoardData;
	task: RuntimeBoardCard;
}

export interface RuntimeMoveTaskResult {
	moved: boolean;
	board: RuntimeBoardData;
	task: RuntimeBoardCard | null;
	fromColumnId: RuntimeBoardColumnId | null;
}

export interface RuntimeUpdateTaskResult {
	board: RuntimeBoardData;
	task: RuntimeBoardCard | null;
	updated: boolean;
}

export interface RuntimeImportedBacklogTaskResult {
	board: RuntimeBoardData;
	task: RuntimeBoardCard;
	status: "created" | "updated" | "unchanged" | "skipped";
	columnId: RuntimeBoardColumnId;
	reason?: "not_backlog";
}

export interface RuntimeAddTaskDependencyResult {
	board: RuntimeBoardData;
	added: boolean;
	reason?: "missing_task" | "same_task" | "duplicate" | "trash_task" | "non_backlog";
	dependency?: RuntimeBoardDependency;
}

export interface RuntimeRemoveTaskDependencyResult {
	board: RuntimeBoardData;
	removed: boolean;
}

export interface RuntimeTrashTaskResult extends RuntimeMoveTaskResult {
	readyTaskIds: string[];
}

export interface RuntimeDeleteTasksResult {
	board: RuntimeBoardData;
	deleted: boolean;
	deletedTaskIds: string[];
}

export function findTaskByExternalSource(
	board: RuntimeBoardData,
	externalSource: RuntimeExternalTaskSourceInput,
):
	| {
			columnId: RuntimeBoardColumnId;
			task: RuntimeBoardCard;
	  }
	| null {
	for (const column of board.columns) {
		const task = column.cards.find((card) => externalTaskSourceMatches(card.externalSource, externalSource));
		if (task) {
			return {
				columnId: column.id,
				task,
			};
		}
	}
	return null;
}

function collectExistingTaskIds(board: RuntimeBoardData): Set<string> {
	const existingIds = new Set<string>();
	for (const column of board.columns) {
		for (const card of column.cards) {
			existingIds.add(card.id);
		}
	}
	return existingIds;
}

function collectTaskIds(board: RuntimeBoardData): Set<string> {
	const taskIds = new Set<string>();
	for (const column of board.columns) {
		for (const card of column.cards) {
			taskIds.add(card.id);
		}
	}
	return taskIds;
}

function createDependencyId(): string {
	return crypto.randomUUID().replaceAll("-", "").slice(0, 8);
}

function createDependencyPairKey(backlogTaskId: string, linkedTaskId: string): string {
	return `${backlogTaskId}::${linkedTaskId}`;
}

function hasDependencyPair(board: RuntimeBoardData, backlogTaskId: string, linkedTaskId: string): boolean {
	const pairKey = createDependencyPairKey(backlogTaskId, linkedTaskId);
	for (const dependency of board.dependencies) {
		const existing = resolveDependencyEndpoints(board, dependency.fromTaskId, dependency.toTaskId);
		if ("reason" in existing) {
			continue;
		}
		if (createDependencyPairKey(existing.backlogTaskId, existing.linkedTaskId) === pairKey) {
			return true;
		}
	}
	return false;
}

function findTaskLocation(
	board: RuntimeBoardData,
	taskId: string,
): {
	columnIndex: number;
	taskIndex: number;
	columnId: RuntimeBoardColumnId;
	task: RuntimeBoardCard;
} | null {
	for (const [columnIndex, column] of board.columns.entries()) {
		const taskIndex = column.cards.findIndex((card) => card.id === taskId);
		if (taskIndex === -1) {
			continue;
		}
		const task = column.cards[taskIndex];
		if (!task) {
			continue;
		}
		return {
			columnIndex,
			taskIndex,
			columnId: column.id,
			task,
		};
	}
	return null;
}

function resolveDependencyEndpoints(
	board: RuntimeBoardData,
	firstTaskId: string,
	secondTaskId: string,
):
	| {
			backlogTaskId: string;
			linkedTaskId: string;
	  }
	| { reason: RuntimeAddTaskDependencyResult["reason"] } {
	const firstColumnId = getTaskColumnId(board, firstTaskId);
	const secondColumnId = getTaskColumnId(board, secondTaskId);
	if (!firstColumnId || !secondColumnId) {
		return { reason: "missing_task" };
	}
	if (firstColumnId === "trash" || secondColumnId === "trash") {
		return { reason: "trash_task" };
	}
	const firstIsBacklog = firstColumnId === "backlog";
	const secondIsBacklog = secondColumnId === "backlog";
	if (firstIsBacklog && secondIsBacklog) {
		return {
			backlogTaskId: firstTaskId,
			linkedTaskId: secondTaskId,
		};
	}
	if (!firstIsBacklog && !secondIsBacklog) {
		return { reason: "non_backlog" };
	}
	return firstIsBacklog
		? { backlogTaskId: firstTaskId, linkedTaskId: secondTaskId }
		: { backlogTaskId: secondTaskId, linkedTaskId: firstTaskId };
}

function getLinkedBacklogTaskIdsReadyAfterTaskTrashed(
	board: RuntimeBoardData,
	taskId: string,
	fromColumnId: RuntimeBoardColumnId | null,
): string[] {
	if (!taskId || board.dependencies.length === 0 || fromColumnId !== "review") {
		return [];
	}
	const readyTaskIds = new Set<string>();
	for (const dependency of board.dependencies) {
		if (dependency.toTaskId !== taskId) {
			continue;
		}
		if (getTaskColumnId(board, dependency.fromTaskId) !== "backlog") {
			continue;
		}
		readyTaskIds.add(dependency.fromTaskId);
	}
	return [...readyTaskIds];
}

export function updateTaskDependencies(board: RuntimeBoardData): RuntimeBoardData {
	if (board.dependencies.length === 0) {
		return board;
	}
	const taskIds = collectTaskIds(board);
	const dependencies: RuntimeBoardDependency[] = [];
	const existingPairs = new Set<string>();
	for (const dependency of board.dependencies) {
		const firstTaskId = dependency.fromTaskId.trim();
		const secondTaskId = dependency.toTaskId.trim();
		if (!firstTaskId || !secondTaskId || firstTaskId === secondTaskId) {
			continue;
		}
		if (!taskIds.has(firstTaskId) || !taskIds.has(secondTaskId)) {
			continue;
		}
		const resolved = resolveDependencyEndpoints(board, firstTaskId, secondTaskId);
		if ("reason" in resolved) {
			continue;
		}
		const pairKey = createDependencyPairKey(resolved.backlogTaskId, resolved.linkedTaskId);
		if (existingPairs.has(pairKey)) {
			continue;
		}
		existingPairs.add(pairKey);
		dependencies.push({
			id: dependency.id,
			fromTaskId: resolved.backlogTaskId,
			toTaskId: resolved.linkedTaskId,
			createdAt: dependency.createdAt,
		});
	}
	if (
		dependencies.length === board.dependencies.length &&
		dependencies.every((dependency, index) => {
			const current = board.dependencies[index];
			return (
				current &&
				current.id === dependency.id &&
				current.fromTaskId === dependency.fromTaskId &&
				current.toTaskId === dependency.toTaskId &&
				current.createdAt === dependency.createdAt
			);
		})
	) {
		return board;
	}
	return {
		...board,
		dependencies,
	};
}

export function addTaskToColumn(
	board: RuntimeBoardData,
	columnId: RuntimeBoardColumnId,
	input: RuntimeCreateTaskInput,
	randomUuid: () => string,
	now: number = Date.now(),
): RuntimeCreateTaskResult {
	const prompt = input.prompt.trim();
	if (!prompt) {
		throw new Error("Task prompt is required.");
	}
	const baseRef = input.baseRef.trim();
	if (!baseRef) {
		throw new Error("Task baseRef is required.");
	}
	const existingIds = collectExistingTaskIds(board);
	const agentId = normalizeTaskAgentId(input.agentId);
	const attachments = input.attachments ?? attachmentsFromImages(input.images);
	const task: RuntimeBoardCard = {
		id: createUniqueTaskId(existingIds, randomUuid),
		prompt,
		startInPlanMode: Boolean(input.startInPlanMode),
		autoReviewEnabled: Boolean(input.autoReviewEnabled),
		autoReviewMode: normalizeTaskAutoReviewMode(input.autoReviewMode),
		attachments: cloneTaskAttachments(attachments),
		images: cloneTaskImages(input.images),
		agentId,
		fallbackAgentId: normalizeTaskFallbackAgentId(input.fallbackAgentId, agentId),
		externalSource: cloneExternalTaskSource(input.externalSource),
		baseRef,
		createdAt: now,
		updatedAt: now,
	};

	const targetColumnIndex = board.columns.findIndex((column) => column.id === columnId);
	if (targetColumnIndex === -1) {
		throw new Error(`Column ${columnId} not found.`);
	}

	const columns = board.columns.map((column, index) => {
		if (index !== targetColumnIndex) {
			return column;
		}
		return {
			...column,
			cards: [task, ...column.cards],
		};
	});

	return {
		board: {
			...board,
			columns,
		},
		task,
	};
}

export function getTaskColumnId(board: RuntimeBoardData, taskId: string): RuntimeBoardColumnId | null {
	const normalizedTaskId = taskId.trim();
	if (!normalizedTaskId) {
		return null;
	}
	const found = findTaskLocation(board, normalizedTaskId);
	return found ? found.columnId : null;
}

export function addTaskDependency(
	board: RuntimeBoardData,
	firstTaskId: string,
	secondTaskId: string,
): RuntimeAddTaskDependencyResult {
	const normalizedFirstTaskId = firstTaskId.trim();
	const normalizedSecondTaskId = secondTaskId.trim();
	if (!normalizedFirstTaskId || !normalizedSecondTaskId) {
		return { board, added: false, reason: "missing_task" };
	}
	if (normalizedFirstTaskId === normalizedSecondTaskId) {
		return { board, added: false, reason: "same_task" };
	}
	const resolved = resolveDependencyEndpoints(board, normalizedFirstTaskId, normalizedSecondTaskId);
	if ("reason" in resolved) {
		return { board, added: false, reason: resolved.reason };
	}
	if (hasDependencyPair(board, resolved.backlogTaskId, resolved.linkedTaskId)) {
		return { board, added: false, reason: "duplicate" };
	}
	const dependency: RuntimeBoardDependency = {
		id: createDependencyId(),
		fromTaskId: resolved.backlogTaskId,
		toTaskId: resolved.linkedTaskId,
		createdAt: Date.now(),
	};
	return {
		board: {
			...board,
			dependencies: [...board.dependencies, dependency],
		},
		added: true,
		dependency,
	};
}

export function canAddTaskDependency(board: RuntimeBoardData, firstTaskId: string, secondTaskId: string): boolean {
	const normalizedFirstTaskId = firstTaskId.trim();
	const normalizedSecondTaskId = secondTaskId.trim();
	if (!normalizedFirstTaskId || !normalizedSecondTaskId || normalizedFirstTaskId === normalizedSecondTaskId) {
		return false;
	}
	const resolved = resolveDependencyEndpoints(board, normalizedFirstTaskId, normalizedSecondTaskId);
	if ("reason" in resolved) {
		return false;
	}
	return !hasDependencyPair(board, resolved.backlogTaskId, resolved.linkedTaskId);
}

export function removeTaskDependency(board: RuntimeBoardData, dependencyId: string): RuntimeRemoveTaskDependencyResult {
	const dependencies = board.dependencies.filter((dependency) => dependency.id !== dependencyId);
	if (dependencies.length === board.dependencies.length) {
		return { board, removed: false };
	}
	return {
		board: {
			...board,
			dependencies,
		},
		removed: true,
	};
}

export function getReadyLinkedTaskIdsForTaskInTrash(board: RuntimeBoardData, taskId: string): string[] {
	return getLinkedBacklogTaskIdsReadyAfterTaskTrashed(board, taskId, getTaskColumnId(board, taskId));
}

export function trashTaskAndGetReadyLinkedTaskIds(
	board: RuntimeBoardData,
	taskId: string,
	now: number = Date.now(),
): RuntimeTrashTaskResult {
	const fromColumnId = getTaskColumnId(board, taskId);
	const readyTaskIds = getLinkedBacklogTaskIdsReadyAfterTaskTrashed(board, taskId, fromColumnId);
	const movedToTrash = moveTaskToColumn(board, taskId, "trash", now);
	return {
		...movedToTrash,
		readyTaskIds: movedToTrash.moved ? readyTaskIds : [],
	};
}

export function deleteTasksFromBoard(board: RuntimeBoardData, taskIds: Iterable<string>): RuntimeDeleteTasksResult {
	const normalizedTaskIds = new Set(
		Array.from(taskIds, (taskId) => taskId.trim()).filter((taskId) => taskId.length > 0),
	);
	if (normalizedTaskIds.size === 0) {
		return {
			board,
			deleted: false,
			deletedTaskIds: [],
		};
	}

	const deletedTaskIds: string[] = [];
	const columns = board.columns.map((column) => {
		const remainingCards = column.cards.filter((card) => {
			if (!normalizedTaskIds.has(card.id)) {
				return true;
			}
			deletedTaskIds.push(card.id);
			return false;
		});
		return remainingCards.length === column.cards.length ? column : { ...column, cards: remainingCards };
	});

	if (deletedTaskIds.length === 0) {
		return {
			board,
			deleted: false,
			deletedTaskIds: [],
		};
	}

	const deletedTaskIdSet = new Set(deletedTaskIds);
	const dependencies = board.dependencies.filter(
		(dependency) => !deletedTaskIdSet.has(dependency.fromTaskId) && !deletedTaskIdSet.has(dependency.toTaskId),
	);

	return {
		board: {
			...board,
			columns,
			dependencies,
		},
		deleted: true,
		deletedTaskIds,
	};
}

export function moveTaskToColumn(
	board: RuntimeBoardData,
	taskId: string,
	targetColumnId: RuntimeBoardColumnId,
	now: number = Date.now(),
): RuntimeMoveTaskResult {
	const normalizedTaskId = taskId.trim();
	if (!normalizedTaskId) {
		return {
			moved: false,
			board,
			task: null,
			fromColumnId: null,
		};
	}

	const found = findTaskLocation(board, normalizedTaskId);
	if (!found) {
		return {
			moved: false,
			board,
			task: null,
			fromColumnId: null,
		};
	}
	if (found.columnId === targetColumnId) {
		return {
			moved: false,
			board,
			task: found.task,
			fromColumnId: found.columnId,
		};
	}
	const targetColumnIndex = board.columns.findIndex((column) => column.id === targetColumnId);
	if (targetColumnIndex === -1) {
		return {
			moved: false,
			board,
			task: found.task,
			fromColumnId: found.columnId,
		};
	}

	const sourceColumn = board.columns[found.columnIndex];
	const targetColumn = board.columns[targetColumnIndex];
	if (!sourceColumn || !targetColumn) {
		return {
			moved: false,
			board,
			task: found.task,
			fromColumnId: found.columnId,
		};
	}

	const sourceCards = [...sourceColumn.cards];
	const [task] = sourceCards.splice(found.taskIndex, 1);
	if (!task) {
		return {
			moved: false,
			board,
			task: found.task,
			fromColumnId: found.columnId,
		};
	}
	const movedTask: RuntimeBoardCard = {
		...task,
		updatedAt: now,
	};
	const targetCards =
		targetColumnId === "trash" ? [movedTask, ...targetColumn.cards] : [...targetColumn.cards, movedTask];

	const columns = board.columns.map((column, index) => {
		if (index === found.columnIndex) {
			return {
				...column,
				cards: sourceCards,
			};
		}
		if (index === targetColumnIndex) {
			return {
				...column,
				cards: targetCards,
			};
		}
		return column;
	});

	return {
		moved: true,
		board: updateTaskDependencies({
			...board,
			columns,
		}),
		task: movedTask,
		fromColumnId: found.columnId,
	};
}

export function updateTask(
	board: RuntimeBoardData,
	taskId: string,
	input: RuntimeUpdateTaskInput,
	now: number = Date.now(),
): RuntimeUpdateTaskResult {
	const normalizedTaskId = taskId.trim();
	if (!normalizedTaskId) {
		return {
			board,
			task: null,
			updated: false,
		};
	}

	const prompt = input.prompt.trim();
	if (!prompt) {
		return {
			board,
			task: null,
			updated: false,
		};
	}

	const baseRef = input.baseRef.trim();
	if (!baseRef) {
		return {
			board,
			task: null,
			updated: false,
		};
	}

	let updatedTask: RuntimeBoardCard | null = null;
	const columns = board.columns.map((column) => {
		let columnUpdated = false;
		const cards = column.cards.map((card) => {
			if (card.id !== normalizedTaskId) {
				return card;
			}
			columnUpdated = true;
			const preferredAgentId = normalizeTaskAgentId(input.agentId);
			const attachments = input.attachments ?? (input.images === undefined ? undefined : attachmentsFromImages(input.images));
			updatedTask = {
				...card,
				prompt,
				startInPlanMode: Boolean(input.startInPlanMode),
				autoReviewEnabled: Boolean(input.autoReviewEnabled),
				autoReviewMode: normalizeTaskAutoReviewMode(input.autoReviewMode),
				attachments: attachments === undefined ? card.attachments : cloneTaskAttachments(attachments),
				images: input.images === undefined ? card.images : cloneTaskImages(input.images),
				agentId: preferredAgentId,
				fallbackAgentId:
					input.fallbackAgentId === undefined
						? card.fallbackAgentId
						: normalizeTaskFallbackAgentId(input.fallbackAgentId, preferredAgentId),
				baseRef,
				updatedAt: now,
			};
			if (card.externalSource !== undefined) {
				updatedTask.externalSource =
					input.externalSource === undefined ? card.externalSource : cloneExternalTaskSource(input.externalSource);
			}
			return updatedTask;
		});
		return columnUpdated ? { ...column, cards } : column;
	});

	if (!updatedTask) {
		return {
			board,
			task: null,
			updated: false,
		};
	}

	return {
		board: {
			...board,
			columns,
		},
		task: updatedTask,
		updated: true,
	};
}

export function upsertBacklogTaskByExternalSource(
	board: RuntimeBoardData,
	input: RuntimeImportBacklogTaskInput,
	randomUuid: () => string,
	now: number = Date.now(),
): RuntimeImportedBacklogTaskResult {
	const existing = findTaskByExternalSource(board, input.externalSource);
	if (!existing) {
		const created = addTaskToColumn(
			board,
			"backlog",
			{
				prompt: input.prompt,
				startInPlanMode: input.startInPlanMode,
				autoReviewEnabled: input.autoReviewEnabled,
				autoReviewMode: input.autoReviewMode,
				externalSource: normalizeExternalTaskSource(input.externalSource, now),
				baseRef: input.baseRef,
			},
			randomUuid,
			now,
		);
		return {
			board: created.board,
			task: created.task,
			status: "created",
			columnId: "backlog",
		};
	}

	const nextExternalSource = normalizeExternalTaskSource(
		input.externalSource,
		existing.task.externalSource?.importedAt ?? now,
	);
	if (existing.columnId !== "backlog") {
		return {
			board,
			task: existing.task,
			status: "skipped",
			columnId: existing.columnId,
			reason: "not_backlog",
		};
	}
	const nextStartInPlanMode = input.startInPlanMode ?? existing.task.startInPlanMode;
	const nextAutoReviewEnabled = input.autoReviewEnabled ?? existing.task.autoReviewEnabled;
	const nextAutoReviewMode = input.autoReviewMode ?? existing.task.autoReviewMode;
	const nextBaseRef = input.baseRef.trim();
	const noChanges =
		existing.task.prompt === input.prompt.trim() &&
		existing.task.baseRef === nextBaseRef &&
		existing.task.startInPlanMode === Boolean(nextStartInPlanMode) &&
		Boolean(existing.task.autoReviewEnabled) === Boolean(nextAutoReviewEnabled) &&
		normalizeTaskAutoReviewMode(existing.task.autoReviewMode) === normalizeTaskAutoReviewMode(nextAutoReviewMode) &&
		externalTaskSourceEquals(existing.task.externalSource, nextExternalSource);
	if (noChanges) {
		return {
			board,
			task: existing.task,
			status: "unchanged",
			columnId: existing.columnId,
		};
	}

	const updated = updateTask(
		board,
		existing.task.id,
		{
			prompt: input.prompt,
			baseRef: nextBaseRef,
			startInPlanMode: nextStartInPlanMode,
			autoReviewEnabled: nextAutoReviewEnabled,
			autoReviewMode: nextAutoReviewMode,
			attachments: existing.task.attachments,
			images: existing.task.images,
			agentId: existing.task.agentId,
			fallbackAgentId: existing.task.fallbackAgentId,
			externalSource: nextExternalSource,
		},
		now,
	);
	return {
		board: updated.board,
		task: updated.task ?? existing.task,
		status: "updated",
		columnId: existing.columnId,
	};
}
