export const RUN_STATUS_VALUES = [
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
] as const;

export type RunStatus = (typeof RUN_STATUS_VALUES)[number];

export const TERMINAL_RUN_STATUSES = new Set<RunStatus>([
	"succeeded",
	"failed",
	"canceled",
	"blocked_mcp_write_missing",
	"blocked_invalid_agent_output",
	"blocked_invariant_mismatch",
	"lost_lock",
	"lost_lock_forced",
]);

export const NON_TERMINAL_RUN_STATUSES = new Set<RunStatus>([
	"queued",
	"claimed",
	"running",
	"blocked_awaiting_approval",
	"blocked_lost_heartbeat",
]);

export const ALLOWED_RUN_STATUS_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
	queued: ["claimed", "canceled"],
	claimed: ["running", "canceled", "failed", "lost_lock", "lost_lock_forced"],
	running: [
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
	],
	blocked_awaiting_approval: ["running", "canceled", "failed", "lost_lock", "lost_lock_forced"],
	blocked_mcp_write_missing: ["running", "queued", "canceled", "failed", "lost_lock", "lost_lock_forced"],
	blocked_invalid_agent_output: ["running", "queued", "canceled", "failed", "lost_lock", "lost_lock_forced"],
	blocked_invariant_mismatch: ["running", "queued", "canceled", "failed", "lost_lock", "lost_lock_forced"],
	blocked_lost_heartbeat: ["canceled", "failed", "lost_lock", "lost_lock_forced"],
	succeeded: [],
	failed: [],
	canceled: [],
	lost_lock: [],
	lost_lock_forced: [],
};

export function isRunStatus(value: string): value is RunStatus {
	return RUN_STATUS_VALUES.includes(value as RunStatus);
}

export function isTerminalRunStatus(status: RunStatus): boolean {
	return TERMINAL_RUN_STATUSES.has(status);
}

export function isNonTerminalRunStatus(status: RunStatus): boolean {
	return NON_TERMINAL_RUN_STATUSES.has(status);
}

export function canTransitionRunStatus(current: RunStatus, target: RunStatus): boolean {
	return ALLOWED_RUN_STATUS_TRANSITIONS[current].includes(target);
}

export function ensureRunStatusTransition(current: RunStatus, target: RunStatus): void {
	if (!canTransitionRunStatus(current, target)) {
		throw new Error(`invalid run status transition: ${current} -> ${target}`);
	}
}
