import { describe, expect, it } from "vitest";

import {
	canSendRuntimeTaskSessionPrompt,
	getRuntimeTaskSessionStatus,
	isRuntimeTaskSessionPromptReady,
} from "@/runtime/task-session-status";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "codex",
		workspacePath: "/tmp/worktree",
		pid: 123,
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

describe("getRuntimeTaskSessionStatus", () => {
	it("classifies permission prompts as needs approval", () => {
		const status = getRuntimeTaskSessionStatus(
			createSummary({
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
			}),
		);

		expect(status.kind).toBe("needs_approval");
		expect(status.isWaitingOnUser).toBe(true);
	});

	it("classifies attention requests as needs input", () => {
		const status = getRuntimeTaskSessionStatus(
			createSummary({
				state: "awaiting_review",
				reviewReason: "attention",
				latestHookActivity: {
					activityText: null,
					toolName: null,
					toolInputSummary: null,
					finalMessage: "Which project path should I use?",
					hookEventName: "Notification",
					notificationType: "user_attention",
					source: "codex",
				},
			}),
		);

		expect(status.kind).toBe("needs_input");
		expect(status.label).toBe("Needs input");
	});

	it("detects agent prompt-ready attention as a sendable prompt state", () => {
		const summary = createSummary({
			state: "awaiting_review",
			reviewReason: "attention",
			latestHookActivity: {
				activityText: "Waiting for input",
				toolName: null,
				toolInputSummary: null,
				finalMessage: null,
				hookEventName: "agent.prompt-ready",
				notificationType: "user_attention",
				source: "codex",
			},
		});

		const status = getRuntimeTaskSessionStatus(summary);
		expect(status.kind).toBe("prompt_ready");
		expect(status.label).toBe("Ready for input");
		expect(status.isWaitingOnUser).toBe(false);
		expect(isRuntimeTaskSessionPromptReady(summary)).toBe(true);
		expect(canSendRuntimeTaskSessionPrompt(summary)).toBe(true);
	});

	it("blocks sending a prompt while the session is waiting on a real user decision", () => {
		const summary = createSummary({
			state: "awaiting_review",
			reviewReason: "attention",
			latestHookActivity: {
				activityText: null,
				toolName: null,
				toolInputSummary: null,
				finalMessage: "Which project path should I use?",
				hookEventName: "Notification",
				notificationType: "user_attention",
				source: "codex",
			},
		});

		expect(canSendRuntimeTaskSessionPrompt(summary)).toBe(false);
	});

	it("does not treat stale prompt-ready activity as sendable after the process exits", () => {
		const summary = createSummary({
			state: "awaiting_review",
			pid: null,
			reviewReason: "exit",
			exitCode: 0,
			latestHookActivity: {
				activityText: "Waiting for input",
				toolName: null,
				toolInputSummary: null,
				finalMessage: null,
				hookEventName: "agent.prompt-ready",
				notificationType: "user_attention",
				source: "codex",
			},
		});

		expect(getRuntimeTaskSessionStatus(summary).kind).toBe("ready_for_review");
		expect(isRuntimeTaskSessionPromptReady(summary)).toBe(false);
		expect(canSendRuntimeTaskSessionPrompt(summary)).toBe(false);
	});

	it("classifies review exits caused by errors as needs review", () => {
		const status = getRuntimeTaskSessionStatus(
			createSummary({
				state: "awaiting_review",
				reviewReason: "error",
			}),
		);

		expect(status.kind).toBe("needs_review");
		expect(status.tone).toBe("danger");
	});

	it("keeps successful review stops as ready for review", () => {
		const status = getRuntimeTaskSessionStatus(
			createSummary({
				state: "awaiting_review",
				reviewReason: "hook",
				latestHookActivity: {
					activityText: null,
					toolName: null,
					toolInputSummary: null,
					finalMessage: "Implemented and tested.",
					hookEventName: "Stop",
					notificationType: null,
					source: "claude",
				},
			}),
		);

		expect(status.kind).toBe("ready_for_review");
		expect(status.label).toBe("Ready for review");
	});
});
