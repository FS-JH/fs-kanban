import { describe, expect, it } from "vitest";

import { getTaskAgentNavbarHint, isTaskAgentSetupSatisfied } from "@/runtime/native-agent";
import type { RuntimeConfigResponse } from "@/runtime/types";

function createRuntimeConfigResponse(
	selectedAgentId: RuntimeConfigResponse["selectedAgentId"],
	overrides?: Partial<RuntimeConfigResponse>,
): RuntimeConfigResponse {
	return {
		selectedAgentId,
		selectedShortcutLabel: null,
		agentAutonomousModeEnabled: true,
		effectiveCommand: selectedAgentId,
		globalConfigPath: "/tmp/global-config.json",
		projectConfigPath: "/tmp/project/.fs-kanban/config.json",
		readyForReviewNotificationsEnabled: true,
		detectedCommands: ["claude", "codex"],
		agents: [
			{
				id: "codex",
				label: "OpenAI Codex",
				binary: "codex",
				command: "codex",
				defaultArgs: [],
				installed: true,
				configured: selectedAgentId === "codex",
			},
			{
				id: "claude",
				label: "Claude Code",
				binary: "claude",
				command: "claude",
				defaultArgs: [],
				installed: true,
				configured: selectedAgentId === "claude",
			},
		],
		shortcuts: [],
		commitPromptTemplate: "",
		openPrPromptTemplate: "",
		commitPromptTemplateDefault: "",
		openPrPromptTemplateDefault: "",
		...overrides,
	};
}

describe("native-agent helpers", () => {
	it("treats any installed launch-supported agent as task-ready", () => {
		expect(isTaskAgentSetupSatisfied(createRuntimeConfigResponse("codex"))).toBe(true);
		expect(isTaskAgentSetupSatisfied(null)).toBeNull();
	});

	it("returns false when no supported agent is installed", () => {
		const config = createRuntimeConfigResponse("codex", {
			agents: [
				{
					id: "codex",
					label: "OpenAI Codex",
					binary: "codex",
					command: "codex",
					defaultArgs: [],
					installed: false,
					configured: true,
				},
				{
					id: "claude",
					label: "Claude Code",
					binary: "claude",
					command: "claude",
					defaultArgs: [],
					installed: false,
					configured: false,
				},
			],
		});
		expect(isTaskAgentSetupSatisfied(config)).toBe(false);
	});

	it("suppresses the navbar setup hint when a supported agent is available", () => {
		expect(getTaskAgentNavbarHint(createRuntimeConfigResponse("claude"))).toBeUndefined();
	});

	it("shows the navbar setup hint when no task agent path is ready", () => {
		const config = createRuntimeConfigResponse("codex", {
			agents: [
				{
					id: "codex",
					label: "OpenAI Codex",
					binary: "codex",
					command: "codex",
					defaultArgs: [],
					installed: false,
					configured: true,
				},
				{
					id: "claude",
					label: "Claude Code",
					binary: "claude",
					command: "claude",
					defaultArgs: [],
					installed: false,
					configured: false,
				},
			],
		});
		expect(getTaskAgentNavbarHint(config)).toBe("No agent configured");
		expect(getTaskAgentNavbarHint(config, { shouldUseNavigationPath: true })).toBeUndefined();
	});
});
