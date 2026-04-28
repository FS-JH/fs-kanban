import type { MutableRefObject } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentTerminalPanel } from "@/components/detail-panels/agent-terminal-panel";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";

vi.mock("@/terminal/use-persistent-terminal-session", () => ({
	usePersistentTerminalSession: () => ({
		clearTerminal: () => {},
		containerRef: { current: null } as MutableRefObject<HTMLDivElement | null>,
		isStopping: false,
		lastError: null,
		stopTerminal: async () => {},
	}),
}));

vi.mock("@/stores/workspace-metadata-store", () => ({
	useTaskWorkspaceSnapshotValue: () => null,
}));

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "codex",
		workspacePath: "/tmp/repo",
		pid: 101,
		startedAt: 1,
		updatedAt: 2,
		lastOutputAt: 2,
		reviewReason: null,
		exitCode: null,
		lastHookAt: 2,
		latestHookActivity: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...overrides,
	};
}

describe("AgentTerminalPanel", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		flushSync(() => {
			root.unmount();
		});
		container.remove();
		document.querySelectorAll("[data-radix-popper-content-wrapper]").forEach((element) => {
			element.remove();
		});
	});

	it("shows a compact actions menu and review lifecycle hint instead of a full trash button", () => {
		flushSync(() => {
			root.render(
				<AgentTerminalPanel
					taskId="task-1"
					workspaceId="workspace-1"
					summary={null}
					taskColumnId="review"
					showMoveToTrash
					onMoveToTrash={() => {}}
				/>,
			);
		});

		expect(container.textContent).toContain(
			"Review holds finished cards until you commit, open a PR, or clean them up. Trash is cleanup, not archive.",
		);
		expect(container.textContent).not.toContain("Move Card To Trash");
		expect(container.querySelector('button[aria-label="Task actions"]')).toBeInstanceOf(HTMLButtonElement);
	});

	it("routes Move to Trash through the compact actions menu", async () => {
		const onMoveToTrash = vi.fn();

		flushSync(() => {
			root.render(
				<AgentTerminalPanel
					taskId="task-1"
					workspaceId="workspace-1"
					summary={null}
					taskColumnId="review"
					showMoveToTrash
					onMoveToTrash={onMoveToTrash}
				/>,
			);
		});

		const trigger = container.querySelector('button[aria-label="Task actions"]');
		expect(trigger).toBeInstanceOf(HTMLButtonElement);
		if (!(trigger instanceof HTMLButtonElement)) {
			throw new Error("Expected task actions trigger.");
		}

		flushSync(() => {
			trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false }));
			trigger.click();
		});

		const moveToTrashItem = Array.from(document.querySelectorAll('[role="menuitem"]')).find(
			(element) => element.textContent?.trim() === "Move to Trash",
		);
		expect(moveToTrashItem).toBeInstanceOf(HTMLElement);
		if (!(moveToTrashItem instanceof HTMLElement)) {
			throw new Error("Expected Move to Trash menu item.");
		}

		flushSync(() => {
			moveToTrashItem.click();
		});

		expect(onMoveToTrash).toHaveBeenCalledTimes(1);
	});

	it("shows a blocked status when the agent needs approval", () => {
		flushSync(() => {
			root.render(
				<AgentTerminalPanel
					taskId="task-1"
					workspaceId="workspace-1"
					summary={createSummary({
						state: "awaiting_review",
						reviewReason: "hook",
						latestHookActivity: {
							activityText: "Waiting for approval",
							toolName: null,
							toolInputSummary: null,
							finalMessage: null,
							hookEventName: "PermissionRequest",
							notificationType: "permission_prompt",
							source: "claude",
						},
					})}
				/>,
			);
		});

		expect(container.textContent).toContain("Needs approval");
		expect(container.textContent).toContain("The agent is blocked until you approve the next step.");
	});

	it("shows a compact blocked status in minimal headers", () => {
		flushSync(() => {
			root.render(
				<AgentTerminalPanel
					taskId="task-1"
					workspaceId="workspace-1"
					summary={createSummary({
						state: "awaiting_review",
						reviewReason: "attention",
						latestHookActivity: {
							activityText: null,
							toolName: null,
							toolInputSummary: null,
							finalMessage: "Need your answer",
							hookEventName: "Notification",
							notificationType: "user_attention",
							source: "codex",
						},
					})}
					showSessionToolbar={false}
					onClose={() => {}}
				/>,
			);
		});

		expect(container.textContent).toContain("Needs input");
	});
});
