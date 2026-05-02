import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectNavigationPanel } from "@/components/project-navigation-panel";
import type { RuntimeProjectSummary, RuntimeTaskSessionSummary } from "@/runtime/types";

function createProject(): RuntimeProjectSummary {
	return {
		id: "qp-automation",
		name: "QP_Automation",
		path: "/Users/fsmini/Apps/QP_Automation",
		taskCounts: {
			backlog: 1,
			in_progress: 0,
			review: 0,
			trash: 0,
		},
	};
}

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "__home_agent__:qp-automation:codex",
		state: "interrupted",
		agentId: "codex",
		workspacePath: "/Users/fsmini/Apps/QP_Automation",
		pid: null,
		startedAt: 1,
		updatedAt: 2,
		lastOutputAt: 2,
		reviewReason: "interrupted",
		exitCode: null,
		lastHookAt: 2,
		latestHookActivity: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...overrides,
	};
}

function renderPanel(container: HTMLElement, summary: RuntimeTaskSessionSummary): void {
	const root = createRoot(container);
	roots.push(root);
	act(() => {
		root.render(
			<ProjectNavigationPanel
				projects={[createProject()]}
				currentProjectId="qp-automation"
				removingProjectId={null}
				activeSection="agent"
				onActiveSectionChange={vi.fn()}
				canShowAgentSection
				agentSectionContent={<div>Agent terminal</div>}
				agentSectionSummary={summary}
				onSelectAllProjects={vi.fn()}
				onSelectProject={vi.fn()}
				onRemoveProject={vi.fn().mockResolvedValue(true)}
				onAddProject={vi.fn()}
			/>,
		);
	});
}

const roots: Root[] = [];

describe("ProjectNavigationPanel", () => {
	let container: HTMLDivElement;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		vi.stubGlobal("__APP_VERSION__", "test");
		container = document.createElement("div");
		document.body.appendChild(container);
	});

	afterEach(() => {
		for (const root of roots.splice(0)) {
			act(() => {
				root.unmount();
			});
		}
		vi.unstubAllGlobals();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
		container.remove();
	});

	it("does not show stale prompt-ready activity after the board agent has stopped", () => {
		renderPanel(
			container,
			createSummary({
				latestHookActivity: {
					activityText: "Waiting for input",
					toolName: null,
					toolInputSummary: null,
					finalMessage: null,
					hookEventName: "agent.prompt-ready",
					notificationType: "user_attention",
					source: "codex",
				},
			}),
		);

		expect(container.textContent).not.toContain("Waiting for input");
		expect(container.textContent).toContain("Board Agent");
	});

	it("shows non-prompt activity in the board agent section", () => {
		renderPanel(
			container,
			createSummary({
				state: "awaiting_review",
				pid: 123,
				reviewReason: "error",
				latestHookActivity: {
					activityText: "Waiting for approval",
					toolName: null,
					toolInputSummary: null,
					finalMessage: null,
					hookEventName: "PermissionRequest",
					notificationType: "permission_prompt",
					source: "codex",
				},
			}),
		);

		expect(container.textContent).toContain("Waiting for approval");
	});
});
