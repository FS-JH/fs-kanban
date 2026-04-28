import type { RuntimeTaskHookActivity } from "../core/api-contract.js";

const PERMISSION_NOTIFICATION_TYPES = new Set(["permission_prompt", "permission.asked"]);
const PERMISSION_HOOK_EVENT_NAMES = new Set([
	"permissionrequest",
	"approval_request",
	"permission_request",
	"approval_requested",
]);
const READ_ONLY_TOOL_NAMES = new Set(["glob", "grep", "ls", "read"]);
const SHELL_LIKE_TOOL_NAMES = new Set(["bash", "exec", "shell"]);
const SAFE_SHELL_COMMAND_PATTERNS = [
	/^git\s+(?:status|diff|show|log|branch(?:\s+--show-current)?|rev-parse|ls-files)(?:\s|$)/i,
	/^(?:rg|grep|find|ls|pwd|cat|head|tail|wc)(?:\s|$)/i,
	/^sed\s+-n(?:\s|$)/i,
];
const SHELL_RISK_MARKER_PATTERN = /[;&|><`$(){}]/;

export interface SupervisedApprovalDecision {
	shouldAutoApprove: boolean;
	reason:
		| "not_permission_prompt"
		| "read_only_tool"
		| "safe_shell_command"
		| "missing_tool_context"
		| "unsafe_shell_command"
		| "unsupported_tool";
}

function normalizeText(value: string | null | undefined): string | null {
	const normalized = value?.trim();
	return normalized ? normalized : null;
}

function normalizeKey(value: string | null | undefined): string | null {
	const normalized = normalizeText(value);
	return normalized ? normalized.toLowerCase() : null;
}

export function isPermissionPromptActivity(activity: Partial<RuntimeTaskHookActivity> | null | undefined): boolean {
	const activityText = normalizeKey(activity?.activityText);
	const hookEventName = normalizeKey(activity?.hookEventName);
	const notificationType = normalizeKey(activity?.notificationType);
	return (
		activityText === "waiting for approval" ||
		(notificationType !== null && PERMISSION_NOTIFICATION_TYPES.has(notificationType)) ||
		(hookEventName !== null && PERMISSION_HOOK_EVENT_NAMES.has(hookEventName))
	);
}

function isSafeShellCommand(command: string): boolean {
	if (!command.trim()) {
		return false;
	}
	if (SHELL_RISK_MARKER_PATTERN.test(command)) {
		return false;
	}
	return SAFE_SHELL_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

export function evaluateSupervisedApproval(
	activity: Partial<RuntimeTaskHookActivity> | null | undefined,
): SupervisedApprovalDecision {
	if (!isPermissionPromptActivity(activity)) {
		return {
			shouldAutoApprove: false,
			reason: "not_permission_prompt",
		};
	}

	const toolName = normalizeKey(activity?.toolName);
	const toolInputSummary = normalizeText(activity?.toolInputSummary);
	if (toolName !== null && READ_ONLY_TOOL_NAMES.has(toolName)) {
		return {
			shouldAutoApprove: true,
			reason: "read_only_tool",
		};
	}

	if (toolName !== null && SHELL_LIKE_TOOL_NAMES.has(toolName)) {
		if (!toolInputSummary) {
			return {
				shouldAutoApprove: false,
				reason: "missing_tool_context",
			};
		}
		return {
			shouldAutoApprove: isSafeShellCommand(toolInputSummary),
			reason: isSafeShellCommand(toolInputSummary) ? "safe_shell_command" : "unsafe_shell_command",
		};
	}

	if (toolName === null && toolInputSummary) {
		return {
			shouldAutoApprove: isSafeShellCommand(toolInputSummary),
			reason: isSafeShellCommand(toolInputSummary) ? "safe_shell_command" : "unsafe_shell_command",
		};
	}

	return {
		shouldAutoApprove: false,
		reason: toolInputSummary ? "unsupported_tool" : "missing_tool_context",
	};
}

export function buildHookActivityFingerprint(activity: Partial<RuntimeTaskHookActivity> | null | undefined): string {
	return JSON.stringify({
		source: normalizeText(activity?.source),
		hookEventName: normalizeText(activity?.hookEventName),
		notificationType: normalizeText(activity?.notificationType),
		toolName: normalizeText(activity?.toolName),
		toolInputSummary: normalizeText(activity?.toolInputSummary),
		activityText: normalizeText(activity?.activityText),
	});
}
