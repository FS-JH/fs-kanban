import { describe, expect, it } from "vitest";

import {
	ALLOWED_RUN_STATUS_TRANSITIONS,
	ensureRunStatusTransition,
	isNonTerminalRunStatus,
	isRunStatus,
	isTerminalRunStatus,
	type RunStatus,
	RUN_STATUS_VALUES,
} from "../../../src/agents/run-status.js";

describe("run status", () => {
	it("exposes the upstream state set", () => {
		expect(RUN_STATUS_VALUES).toEqual([
			"queued",
			"claimed",
			"running",
			"blocked_awaiting_approval",
			"blocked_mcp_write_missing",
			"blocked_invalid_agent_output",
			"blocked_invariant_mismatch",
			"blocked_lost_heartbeat",
			"succeeded",
			"failed",
			"canceled",
			"lost_lock",
			"lost_lock_forced",
		]);
	});

	it("validates transitions", () => {
		expect(ALLOWED_RUN_STATUS_TRANSITIONS.queued).toContain("claimed");
		expect(() => ensureRunStatusTransition("running", "queued")).toThrow(
			"invalid run status transition: running -> queued",
		);
	});

	it("classifies terminal and non-terminal states", () => {
		expect(isRunStatus("queued")).toBe(true);
		expect(isRunStatus("not-a-status")).toBe(false);
		expect(isNonTerminalRunStatus("running")).toBe(true);
		expect(isTerminalRunStatus("succeeded")).toBe(true);
	});

	it("keeps transition types narrow", () => {
		const status: RunStatus = "claimed";
		expect(status).toBe("claimed");
	});
});
