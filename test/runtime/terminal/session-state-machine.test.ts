import { describe, expect, it } from "vitest";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract.js";
import { reduceSessionTransition } from "../../../src/terminal/session-state-machine.js";

function summary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		mode: null,
		agentId: "codex",
		workspacePath: "/tmp/wt",
		pid: 1234,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: Date.now(),
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		warningMessage: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...overrides,
	};
}

describe("reduceSessionTransition — agent.needs-input", () => {
	it("transitions running → awaiting_review with reason 'attention' on first prompt", () => {
		const result = reduceSessionTransition(summary(), { type: "agent.needs-input" });
		expect(result.changed).toBe(true);
		expect(result.patch.state).toBe("awaiting_review");
		expect(result.patch.reviewReason).toBe("attention");
		expect(result.patch.latestHookActivity?.activityText).toBe("Waiting for input");
		expect(result.patch.latestHookActivity?.notificationType).toBe("user_attention");
		expect(result.patch.latestHookActivity?.source).toBe("codex");
	});

	it("is a no-op when already awaiting_review", () => {
		const result = reduceSessionTransition(
			summary({ state: "awaiting_review", reviewReason: "attention" }),
			{ type: "agent.needs-input" },
		);
		expect(result.changed).toBe(false);
	});

	it("is idempotent when running summary already carries the Waiting-for-input marker", () => {
		// This is the real duplicate condition: detector still fires while state hasn't been broadcast yet.
		const result = reduceSessionTransition(
			summary({
				state: "running",
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
			{ type: "agent.needs-input" },
		);
		expect(result.changed).toBe(false);
	});
});

describe("reduceSessionTransition — agent.prompt-ready", () => {
	it("returns an attention prompt to running and clears the stale prompt marker", () => {
		const result = reduceSessionTransition(
			summary({
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
			}),
			{ type: "agent.prompt-ready" },
		);

		expect(result.changed).toBe(true);
		expect(result.patch.state).toBe("running");
		expect(result.patch.reviewReason).toBeNull();
		expect(result.patch.latestHookActivity).toBeNull();
	});
});
