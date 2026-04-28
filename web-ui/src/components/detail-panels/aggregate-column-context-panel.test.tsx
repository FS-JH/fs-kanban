import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AggregateColumnContextPanel } from "@/components/detail-panels/aggregate-column-context-panel";
import type { RuntimeAggregateBoardCard, RuntimeAggregateBoardData } from "@/runtime/types";

vi.mock("@/components/board-card", () => ({
	BoardCard: ({
		card,
		selected,
		onClick,
	}: {
		card: { id: string; prompt: string };
		selected?: boolean;
		onClick?: () => void;
	}): React.ReactElement => {
		return (
			<button type="button" data-task-id={card.id} data-selected={selected ? "true" : "false"} onClick={onClick}>
				{card.prompt}
			</button>
		);
	},
}));

function createAggregateCard(input: {
	workspaceId: string;
	projectName: string;
	projectPath: string;
	taskId: string;
	prompt: string;
	columnId: "in_progress" | "review";
}): RuntimeAggregateBoardCard {
	return {
		key: `${input.workspaceId}:${input.taskId}`,
		workspaceId: input.workspaceId,
		projectName: input.projectName,
		projectPath: input.projectPath,
		columnId: input.columnId,
		card: {
			id: input.taskId,
			prompt: input.prompt,
			startInPlanMode: false,
			autoReviewEnabled: false,
			autoReviewMode: "commit",
			baseRef: "main",
			createdAt: 1,
			updatedAt: 1,
		},
		session: null,
		taskWorkspace: null,
	};
}

function createBoard(): RuntimeAggregateBoardData {
	const first = createAggregateCard({
		workspaceId: "workspace-a",
		projectName: "Project A",
		projectPath: "/tmp/project-a",
		taskId: "task-1",
		prompt: "Shared id in A",
		columnId: "in_progress",
	});
	const second = createAggregateCard({
		workspaceId: "workspace-b",
		projectName: "Project B",
		projectPath: "/tmp/project-b",
		taskId: "task-1",
		prompt: "Shared id in B",
		columnId: "review",
	});
	return {
		columns: [
			{ id: "in_progress", title: "In Progress", cards: [first] },
			{ id: "review", title: "Review", cards: [second] },
		],
	};
}

describe("AggregateColumnContextPanel", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;
	let scrollIntoViewMock: ReturnType<typeof vi.fn>;

	const waitForRender = async (): Promise<void> => {
		await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
		await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
	};

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		scrollIntoViewMock = vi.fn();
		Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
			configurable: true,
			value: scrollIntoViewMock,
		});
		vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
			callback(0);
			return 1;
		});
		vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
	});

	afterEach(() => {
		root.unmount();
		vi.restoreAllMocks();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("selects duplicate task ids by aggregate card key", async () => {
		root.render(
			<AggregateColumnContextPanel
				data={createBoard()}
				selectedCardKey="workspace-b:task-1"
				onCardSelect={() => {}}
				onCommitTask={() => {}}
				onOpenPrTask={() => {}}
				onMoveToTrashTask={() => {}}
				onCancelAutomaticTaskAction={() => {}}
				commitTaskLoadingById={{}}
				openPrTaskLoadingById={{}}
				moveToTrashLoadingById={{}}
			/>,
		);
		await waitForRender();

		const taskButtons = Array.from(container.querySelectorAll<HTMLButtonElement>("[data-task-id='task-1']"));
		expect(taskButtons).toHaveLength(2);
		expect(taskButtons.map((button) => button.dataset.selected)).toEqual(["false", "true"]);
		expect(container.textContent).toContain("Project A");
		expect(container.textContent).toContain("Project B");
		expect(container.querySelector("[data-aggregate-card-key='workspace-b:task-1']")).not.toBeNull();
		expect(scrollIntoViewMock).toHaveBeenCalledWith({
			block: "center",
			inline: "nearest",
		});
	});

	it("returns the aggregate card when a sidebar card is clicked", async () => {
		const selectedCards: RuntimeAggregateBoardCard[] = [];
		root.render(
			<AggregateColumnContextPanel
				data={createBoard()}
				selectedCardKey={null}
				onCardSelect={(card) => selectedCards.push(card)}
				onCommitTask={() => {}}
				onOpenPrTask={() => {}}
				onMoveToTrashTask={() => {}}
				onCancelAutomaticTaskAction={() => {}}
				commitTaskLoadingById={{}}
				openPrTaskLoadingById={{}}
				moveToTrashLoadingById={{}}
			/>,
		);
		await waitForRender();

		const projectBButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
			button.textContent?.includes("Shared id in B"),
		);
		expect(projectBButton).toBeDefined();
		projectBButton?.click();
		await waitForRender();

		expect(selectedCards.map((card) => card.key)).toEqual(["workspace-b:task-1"]);
	});
});
