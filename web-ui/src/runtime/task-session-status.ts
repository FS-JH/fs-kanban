import type { RuntimeTaskSessionSummary } from "@/runtime/types";

export type RuntimeTaskSessionStatusKind =
	| "idle"
	| "running"
	| "prompt_ready"
	| "ready_for_review"
	| "needs_approval"
	| "needs_input"
	| "needs_review"
	| "failed"
	| "interrupted";

export type RuntimeTaskSessionTone = "neutral" | "info" | "success" | "warning" | "danger";

export interface RuntimeTaskSessionStatus {
	kind: RuntimeTaskSessionStatusKind;
	label: string;
	tone: RuntimeTaskSessionTone;
	isWaitingOnUser: boolean;
}

function normalizeText(value: string | null | undefined): string | null {
	const normalized = value?.trim();
	return normalized ? normalized : null;
}

function hasPermissionPromptSignal(summary: RuntimeTaskSessionSummary): boolean {
	const activityText = normalizeText(summary.latestHookActivity?.activityText)?.toLowerCase() ?? null;
	const hookEventName = normalizeText(summary.latestHookActivity?.hookEventName)?.toLowerCase() ?? null;
	const notificationType = normalizeText(summary.latestHookActivity?.notificationType)?.toLowerCase() ?? null;
	return (
		activityText === "waiting for approval" ||
		hookEventName === "permissionrequest" ||
		notificationType === "permission_prompt" ||
		notificationType === "permission.asked"
	);
}

function hasUserAttentionSignal(summary: RuntimeTaskSessionSummary): boolean {
	const notificationType = normalizeText(summary.latestHookActivity?.notificationType)?.toLowerCase() ?? null;
	const hookEventName = normalizeText(summary.latestHookActivity?.hookEventName)?.toLowerCase() ?? null;
	return notificationType === "user_attention" && hookEventName !== "agent.prompt-ready";
}

export function isRuntimeTaskSessionPromptReady(
	summary: RuntimeTaskSessionSummary | null | undefined,
): boolean {
	if (!summary || summary.pid === null) {
		return false;
	}
	const hookEventName = normalizeText(summary?.latestHookActivity?.hookEventName)?.toLowerCase() ?? null;
	return hookEventName === "agent.prompt-ready";
}

export function canSendRuntimeTaskSessionPrompt(summary: RuntimeTaskSessionSummary | null | undefined): boolean {
	if (summary && summary.pid === null) {
		return false;
	}
	const status = getRuntimeTaskSessionStatus(summary);
	if (status.kind === "needs_approval" || status.kind === "needs_review") {
		return false;
	}
	if (status.kind === "needs_input") {
		return isRuntimeTaskSessionPromptReady(summary);
	}
	return true;
}

export function getRuntimeTaskSessionStatus(
	summary: RuntimeTaskSessionSummary | null | undefined,
): RuntimeTaskSessionStatus {
	if (!summary) {
		return {
			kind: "idle",
			label: "No session yet",
			tone: "neutral",
			isWaitingOnUser: false,
		};
	}

	if (summary.state === "failed") {
		return {
			kind: "failed",
			label: "Failed",
			tone: "danger",
			isWaitingOnUser: false,
		};
	}

	if (summary.state === "interrupted") {
		return {
			kind: "interrupted",
			label: "Interrupted",
			tone: "danger",
			isWaitingOnUser: false,
		};
	}

	if (summary.state === "running") {
		return {
			kind: "running",
			label: "Running",
			tone: "info",
			isWaitingOnUser: false,
		};
	}

	if (summary.state !== "awaiting_review") {
		return {
			kind: "idle",
			label: "Idle",
			tone: "neutral",
			isWaitingOnUser: false,
		};
	}

	if (hasPermissionPromptSignal(summary)) {
		return {
			kind: "needs_approval",
			label: "Needs approval",
			tone: "warning",
			isWaitingOnUser: true,
		};
	}

	if (isRuntimeTaskSessionPromptReady(summary)) {
		return {
			kind: "prompt_ready",
			label: "Ready for input",
			tone: "success",
			isWaitingOnUser: false,
		};
	}

	const hasPromptReadyActivity =
		normalizeText(summary.latestHookActivity?.hookEventName)?.toLowerCase() === "agent.prompt-ready";
	if ((summary.reviewReason === "attention" && !hasPromptReadyActivity) || hasUserAttentionSignal(summary)) {
		return {
			kind: "needs_input",
			label: "Needs input",
			tone: "warning",
			isWaitingOnUser: true,
		};
	}

	if (summary.reviewReason === "error") {
		return {
			kind: "needs_review",
			label: "Needs review",
			tone: "danger",
			isWaitingOnUser: true,
		};
	}

	return {
		kind: "ready_for_review",
		label: "Ready for review",
		tone: "success",
		isWaitingOnUser: false,
	};
}

export function isRuntimeTaskSessionAttentionRequired(summary: RuntimeTaskSessionSummary | null | undefined): boolean {
	const status = getRuntimeTaskSessionStatus(summary);
	return status.kind === "needs_approval" || status.kind === "needs_input" || status.kind === "needs_review";
}
