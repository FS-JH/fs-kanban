import { describe, expect, it } from "vitest";

import type { RuntimeConfigResponse, RuntimeTaskSessionSummary } from "@/runtime/types";
import type { BoardCard } from "@/types";
import {
	getTaskRetryAgentOptions,
	resolveTaskFallbackAgentId,
	resolveTaskPreferredAgentId,
} from "@/utils/task-agent-preferences";

function createRuntimeConfig(overrides: Partial<RuntimeConfigResponse> = {}): RuntimeConfigResponse {
	const base: RuntimeConfigResponse = {
		selectedAgentId: "codex",
		fallbackAgentId: "claude",
		selectedShortcutLabel: null,
		agentApprovalMode: "full_auto",
		agentAutonomousModeEnabled: true,
		effectiveCommand: "codex",
		globalConfigPath: "/tmp/global-config.json",
		projectConfigPath: "/tmp/project-config.json",
		readyForReviewNotificationsEnabled: true,
		detectedCommands: ["codex", "claude"],
		agents: [
			{
				id: "codex",
				label: "OpenAI Codex",
				binary: "codex",
				command: "codex",
				defaultArgs: [],
				installed: true,
				configured: true,
			},
			{
				id: "claude",
				label: "Claude Code",
				binary: "claude",
				command: "claude",
				defaultArgs: [],
				installed: true,
				configured: false,
			},
		],
		shortcuts: [],
		commitPromptTemplate: "commit",
		openPrPromptTemplate: "pr",
		commitPromptTemplateDefault: "commit",
		openPrPromptTemplateDefault: "pr",
	};
	const merged = { ...base, ...overrides };
	const agentApprovalMode = merged.agentApprovalMode;
	return {
		...merged,
		agentApprovalMode,
		agentAutonomousModeEnabled: agentApprovalMode === "full_auto",
	};
}

function createCard(overrides: Partial<BoardCard> = {}): BoardCard {
	return {
		id: "task-1",
		prompt: "Do the work",
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		agentId: undefined,
		fallbackAgentId: undefined,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "failed",
		mode: "act",
		agentId: "codex",
		workspacePath: "/tmp/task-1",
		pid: null,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 1,
		reviewReason: "error",
		exitCode: 1,
		lastHookAt: null,
		latestHookActivity: null,
		warningMessage: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...overrides,
	};
}

describe("task-agent-preferences", () => {
	it("resolves preferred and fallback agents from card overrides before workspace defaults", () => {
		const config = createRuntimeConfig();
		const card = createCard({ agentId: "claude", fallbackAgentId: "codex" });

		expect(resolveTaskPreferredAgentId(card, config)).toBe("claude");
		expect(resolveTaskFallbackAgentId(card, config)).toBe("codex");
	});

	it("drops fallback agents that duplicate the effective preferred agent", () => {
		const config = createRuntimeConfig();
		const card = createCard({ fallbackAgentId: "codex" });

		expect(resolveTaskPreferredAgentId(card, config)).toBe("codex");
		expect(resolveTaskFallbackAgentId(card, config)).toBeNull();
	});

	it("leads with a resume option for the current agent and includes fallback alternates", () => {
		const config = createRuntimeConfig();
		const retryOptions = getTaskRetryAgentOptions(createCard(), createSummary({ agentId: "codex" }), config);

		expect(retryOptions.map((option) => option.id)).toEqual(["codex", "claude"]);
		expect(retryOptions[0]?.reason).toBe("resume");
		expect(retryOptions[1]?.reason).toBe("fallback");
	});

	it("offers a resume option for cleanly-finished idle tasks (review column)", () => {
		const config = createRuntimeConfig();
		const retryOptions = getTaskRetryAgentOptions(createCard(), createSummary({ state: "idle" }), config);

		expect(retryOptions.length).toBeGreaterThan(0);
		expect(retryOptions[0]?.reason).toBe("resume");
	});

	it("returns no retry options when the task session is currently running", () => {
		const config = createRuntimeConfig();
		const retryOptions = getTaskRetryAgentOptions(createCard(), createSummary({ state: "running" }), config);

		expect(retryOptions).toEqual([]);
	});

	it("returns no retry options when the task session is in awaiting_review", () => {
		const config = createRuntimeConfig();
		const retryOptions = getTaskRetryAgentOptions(
			createCard(),
			createSummary({ state: "awaiting_review" }),
			config,
		);

		expect(retryOptions).toEqual([]);
	});
});
