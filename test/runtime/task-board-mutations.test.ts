import { describe, expect, it } from "vitest";

import type { RuntimeBoardData } from "../../src/core/api-contract.js";
import {
	addTaskDependency,
	addTaskToColumn,
	deleteTasksFromBoard,
	findTaskByExternalSource,
	trashTaskAndGetReadyLinkedTaskIds,
	updateTask,
	upsertBacklogTaskByExternalSource,
} from "../../src/core/task-board-mutations.js";

function createBoard(): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Trash", cards: [] },
		],
		dependencies: [],
	};
}

describe("deleteTasksFromBoard", () => {
	it("removes a trashed task and any dependencies that reference it", () => {
		const createA = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task A", baseRef: "main" },
			() => "aaaaa111",
		);
		const createB = addTaskToColumn(createA.board, "review", { prompt: "Task B", baseRef: "main" }, () => "bbbbb111");
		const linked = addTaskDependency(createB.board, "aaaaa", "bbbbb");
		if (!linked.added) {
			throw new Error("Expected dependency to be created.");
		}
		const trashed = trashTaskAndGetReadyLinkedTaskIds(linked.board, "bbbbb");
		const deleted = deleteTasksFromBoard(trashed.board, ["bbbbb"]);

		expect(deleted.deleted).toBe(true);
		expect(deleted.deletedTaskIds).toEqual(["bbbbb"]);
		expect(deleted.board.columns.find((column) => column.id === "trash")?.cards).toEqual([]);
		expect(deleted.board.dependencies).toEqual([]);
	});

	it("removes multiple trashed tasks at once", () => {
		const createA = addTaskToColumn(createBoard(), "trash", { prompt: "Task A", baseRef: "main" }, () => "aaaaa111");
		const createB = addTaskToColumn(createA.board, "trash", { prompt: "Task B", baseRef: "main" }, () => "bbbbb111");

		const deleted = deleteTasksFromBoard(createB.board, ["aaaaa", "bbbbb"]);

		expect(deleted.deleted).toBe(true);
		expect(deleted.deletedTaskIds.sort()).toEqual(["aaaaa", "bbbbb"]);
		expect(deleted.board.columns.find((column) => column.id === "trash")?.cards).toEqual([]);
	});
});


describe("task images", () => {
	it("preserves images when creating and updating tasks", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Task with image",
				baseRef: "main",
				images: [
					{
						id: "img-1",
						data: "abc123",
						mimeType: "image/png",
					},
				],
			},
			() => "aaaaa111",
		);

		expect(created.task.images).toEqual([
			{
				id: "img-1",
				data: "abc123",
				mimeType: "image/png",
			},
		]);

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Task with updated image",
			baseRef: "main",
			images: [
				{
					id: "img-2",
					data: "def456",
					mimeType: "image/jpeg",
				},
			],
		});

		expect(updated.task?.images).toEqual([
			{
				id: "img-2",
				data: "def456",
				mimeType: "image/jpeg",
			},
		]);
	});

	it("does not attach external source metadata to a task that did not already have it", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Plain task",
				baseRef: "main",
			},
			() => "aaaaa111",
			100,
		);

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Plain task updated",
			baseRef: "main",
			externalSource: {
				provider: "notion",
				externalId: "page-plain",
				externalUrl: "https://notion.so/page-plain",
				repoKey: "fs-kanban",
				itemType: "bug",
				sourceUpdatedAt: "2026-04-02T00:00:00.000Z",
				importedAt: 100,
			},
		});

		expect(updated.task?.externalSource).toBeUndefined();
	});
});

describe("external backlog imports", () => {
	it("creates a new backlog task when the external item is not present", () => {
		const imported = upsertBacklogTaskByExternalSource(
			createBoard(),
			{
				prompt: "Imported task",
				baseRef: "main",
				externalSource: {
					provider: "notion",
					externalId: "page-1",
					externalUrl: "https://notion.so/page-1",
					repoKey: "fs-kanban",
					itemType: "bug",
					sourceUpdatedAt: "2026-04-02T00:00:00.000Z",
				},
			},
			() => "aaaaa111",
			123,
		);

		expect(imported.status).toBe("created");
		expect(imported.columnId).toBe("backlog");
		expect(imported.task.externalSource).toEqual({
			provider: "notion",
			externalId: "page-1",
			externalUrl: "https://notion.so/page-1",
			repoKey: "fs-kanban",
			itemType: "bug",
			sourceUpdatedAt: "2026-04-02T00:00:00.000Z",
			importedAt: 123,
		});
	});

	it("updates an existing backlog task with the same external source", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Old prompt",
				baseRef: "main",
				externalSource: {
					provider: "notion",
					externalId: "page-1",
					externalUrl: "https://notion.so/page-1",
					repoKey: "fs-kanban",
					itemType: "bug",
					sourceUpdatedAt: "2026-04-01T00:00:00.000Z",
					importedAt: 100,
				},
			},
			() => "aaaaa111",
			100,
		);

		const imported = upsertBacklogTaskByExternalSource(
			created.board,
			{
				prompt: "Updated prompt",
				baseRef: "main",
				externalSource: {
					provider: "notion",
					externalId: "page-1",
					externalUrl: "https://notion.so/page-1",
					repoKey: "fs-kanban",
					itemType: "enhancement",
					sourceUpdatedAt: "2026-04-02T00:00:00.000Z",
				},
			},
			() => "bbbbb111",
			200,
		);

		expect(imported.status).toBe("updated");
		expect(imported.columnId).toBe("backlog");
		expect(findTaskByExternalSource(imported.board, {
			provider: "notion",
			externalId: "page-1",
			externalUrl: "https://notion.so/page-1",
			repoKey: "fs-kanban",
			itemType: "enhancement",
			sourceUpdatedAt: "2026-04-02T00:00:00.000Z",
		})?.columnId).toBe("backlog");
		expect(imported.task.prompt).toBe("Updated prompt");
		expect(imported.task.externalSource?.importedAt).toBe(100);
		expect(imported.board.columns.find((column) => column.id === "backlog")?.cards).toHaveLength(1);
	});

	it("skips updates when the imported task has already moved out of backlog", () => {
		const created = addTaskToColumn(
			createBoard(),
			"in_progress",
			{
				prompt: "Active task",
				baseRef: "main",
				externalSource: {
					provider: "notion",
					externalId: "page-2",
					externalUrl: "https://notion.so/page-2",
					repoKey: "foundation-ea",
					itemType: "feature_request",
					sourceUpdatedAt: "2026-04-01T00:00:00.000Z",
					importedAt: 100,
				},
			},
			() => "aaaaa111",
			100,
		);

		const imported = upsertBacklogTaskByExternalSource(
			created.board,
			{
				prompt: "Changed prompt from Notion",
				baseRef: "main",
				externalSource: {
					provider: "notion",
					externalId: "page-2",
					externalUrl: "https://notion.so/page-2",
					repoKey: "foundation-ea",
					itemType: "feature_request",
					sourceUpdatedAt: "2026-04-02T00:00:00.000Z",
				},
			},
			() => "bbbbb111",
			200,
		);

		expect(imported.status).toBe("skipped");
		expect(imported.reason).toBe("not_backlog");
		expect(imported.columnId).toBe("in_progress");
		expect(imported.task.prompt).toBe("Active task");
	});
});
