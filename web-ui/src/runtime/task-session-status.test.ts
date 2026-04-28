import { describe, expect, it } from "vitest";

import { getRuntimeTaskSessionStatus } from "@/runtime/task-session-status";
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
