import { join } from "node:path";

import type {
	RuntimeAgentId,
	RuntimeHookEvent,
	RuntimeTaskAttachment,
	RuntimeTaskImage,
	RuntimeTaskSessionSummary,
} from "../core/api-contract.js";
import { buildKanbanCommandParts } from "../core/kanban-command.js";
import { quoteShellArg } from "../core/shell.js";
import { lockedFileSystem } from "../fs/locked-file-system.js";
import { resolveHomeAgentAppendSystemPrompt } from "../prompts/append-system-prompt.js";
import { getRuntimeHomePath } from "../state/workspace-state.js";
import { createHookRuntimeEnv } from "./hook-runtime-context.js";
import { stripAnsi } from "./output-utils.js";
import type { SessionTransitionEvent } from "./session-state-machine.js";
import { prepareTaskPromptWithAttachments } from "./task-attachment-prompt.js";

export interface AgentAdapterLaunchInput {
	taskId: string;
	agentId: RuntimeAgentId;
	binary?: string;
	args: string[];
	autonomousModeEnabled?: boolean;
	cwd: string;
	prompt: string;
	attachments?: RuntimeTaskAttachment[];
	images?: RuntimeTaskImage[];
	startInPlanMode?: boolean;
	resumeFromTrash?: boolean;
	env?: Record<string, string | undefined>;
	workspaceId?: string;
}

export type AgentOutputTransitionDetector = (
	data: string,
	summary: RuntimeTaskSessionSummary,
) => SessionTransitionEvent | null;

export type AgentOutputTransitionInspectionPredicate = (summary: RuntimeTaskSessionSummary) => boolean;

export interface PreparedAgentLaunch {
	binary?: string;
	args: string[];
	env: Record<string, string | undefined>;
	cleanup?: () => Promise<void>;
	detectOutputTransition?: AgentOutputTransitionDetector;
	shouldInspectOutputForTransition?: AgentOutputTransitionInspectionPredicate;
}

interface HookContext {
	taskId: string;
	workspaceId: string;
}

interface HookCommandMetadata {
	source?: string;
	activityText?: string;
	hookEventName?: string;
	notificationType?: string;
}

interface AgentSessionAdapter {
	prepare(input: AgentAdapterLaunchInput): Promise<PreparedAgentLaunch>;
}

function resolveHookContext(input: AgentAdapterLaunchInput): HookContext | null {
	const workspaceId = input.workspaceId?.trim();
	if (!workspaceId) {
		return null;
	}
	return {
		taskId: input.taskId,
		workspaceId,
	};
}

function buildHookCommand(event: RuntimeHookEvent, metadata?: HookCommandMetadata): string {
	const parts = buildHooksCommandParts(["ingest", "--event", event]);
	if (metadata?.source) {
		parts.push("--source", metadata.source);
	}
	if (metadata?.activityText) {
		parts.push("--activity-text", metadata.activityText);
	}
	if (metadata?.hookEventName) {
		parts.push("--hook-event-name", metadata.hookEventName);
	}
	if (metadata?.notificationType) {
		parts.push("--notification-type", metadata.notificationType);
	}
	return parts.map(quoteShellArg).join(" ");
}

function buildHooksCommandParts(args: string[]): string[] {
	return buildKanbanCommandParts(["hooks", ...args]);
}

function hasCliOption(args: string[], optionName: string): boolean {
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === optionName || arg.startsWith(`${optionName}=`)) {
			return true;
		}
	}
	return false;
}

function hasCodexConfigOverride(args: string[], key: string): boolean {
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "-c" || arg === "--config") {
			const next = args[i + 1];
			if (typeof next === "string" && next.startsWith(`${key}=`)) {
				return true;
			}
			i += 1;
			continue;
		}
		if (arg.startsWith(`-c${key}=`) || arg.startsWith(`--config=${key}=`)) {
			return true;
		}
	}
	return false;
}

function getHookAgentDirectory(agentId: RuntimeAgentId): string {
	return join(getRuntimeHomePath(), "hooks", agentId);
}

async function ensureTextFile(filePath: string, content: string, executable = false): Promise<void> {
	await lockedFileSystem.writeTextFileAtomic(filePath, content, {
		executable,
	});
}

function withPrompt(args: string[], prompt: string, mode: "append" | "flag", flag?: string): PreparedAgentLaunch {
	const trimmed = prompt.trim();
	if (!trimmed) {
		return {
			args,
			env: {},
		};
	}
	if (mode === "flag" && flag) {
		args.push(flag, trimmed);
	} else {
		args.push(trimmed);
	}
	return {
		args,
		env: {},
	};
}

const claudeAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const args = [...input.args];
		const env: Record<string, string | undefined> = {};
		const appendedSystemPrompt = resolveHomeAgentAppendSystemPrompt(input.taskId);
		if (
			input.autonomousModeEnabled &&
			!input.startInPlanMode &&
			!hasCliOption(args, "--dangerously-skip-permissions")
		) {
			args.push("--dangerously-skip-permissions");
		}
		if (input.resumeFromTrash && !hasCliOption(args, "--continue")) {
			args.push("--continue");
		}
		if (input.startInPlanMode) {
			const withoutImmediateBypass = args.filter((arg) => arg !== "--dangerously-skip-permissions");
			args.length = 0;
			args.push(...withoutImmediateBypass);
			if (!hasCliOption(args, "--allow-dangerously-skip-permissions")) {
				args.push("--allow-dangerously-skip-permissions");
			}
			args.push("--permission-mode", "plan");
		}

		const hooks = resolveHookContext(input);
		if (hooks) {
			const settingsPath = join(getHookAgentDirectory("claude"), "settings.json");
			const hooksSettings = {
				hooks: {
					Stop: [{ hooks: [{ type: "command", command: buildHookCommand("to_review", { source: "claude" }) }] }],
					SubagentStop: [
						{ hooks: [{ type: "command", command: buildHookCommand("activity", { source: "claude" }) }] },
					],
					PreToolUse: [
						{
							matcher: "*",
							hooks: [{ type: "command", command: buildHookCommand("activity", { source: "claude" }) }],
						},
					],
					PermissionRequest: [
						{
							matcher: "*",
							hooks: [{ type: "command", command: buildHookCommand("to_review", { source: "claude" }) }],
						},
					],
					PostToolUse: [
						{
							matcher: "*",
							hooks: [{ type: "command", command: buildHookCommand("to_in_progress", { source: "claude" }) }],
						},
					],
					PostToolUseFailure: [
						{
							matcher: "*",
							hooks: [{ type: "command", command: buildHookCommand("to_in_progress", { source: "claude" }) }],
						},
					],
					Notification: [
						{
							matcher: "permission_prompt",
							hooks: [{ type: "command", command: buildHookCommand("to_review", { source: "claude" }) }],
						},
						{
							matcher: "*",
							hooks: [{ type: "command", command: buildHookCommand("activity", { source: "claude" }) }],
						},
					],
					UserPromptSubmit: [
						{
							hooks: [{ type: "command", command: buildHookCommand("to_in_progress", { source: "claude" }) }],
						},
					],
				},
			};
			await ensureTextFile(settingsPath, JSON.stringify(hooksSettings, null, 2));
			args.push("--settings", settingsPath);
			Object.assign(
				env,
				createHookRuntimeEnv({
					taskId: hooks.taskId,
					workspaceId: hooks.workspaceId,
				}),
			);
		}

		if (
			appendedSystemPrompt &&
			!hasCliOption(args, "--append-system-prompt") &&
			!hasCliOption(args, "--system-prompt")
		) {
			args.push("--append-system-prompt", appendedSystemPrompt);
		}

		const withPromptLaunch = withPrompt(args, input.prompt, "append");
		return {
			...withPromptLaunch,
			env: {
				...withPromptLaunch.env,
				...env,
			},
		};
	},
};

function codexPromptDetector(data: string, summary: RuntimeTaskSessionSummary): SessionTransitionEvent | null {
	if (summary.state !== "awaiting_review") {
		return null;
	}
	if (summary.reviewReason !== "attention" && summary.reviewReason !== "hook") {
		return null;
	}
	const stripped = stripAnsi(data);
	if (/(?:^|\n)\s*›/.test(stripped)) {
		return { type: "agent.prompt-ready" };
	}
	return null;
}

function shouldInspectCodexOutputForTransition(summary: RuntimeTaskSessionSummary): boolean {
	return (
		summary.state === "awaiting_review" &&
		(summary.reviewReason === "attention" ||
			summary.reviewReason === "hook" ||
			summary.reviewReason === "error")
	);
}

const codexAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const codexArgs = [...input.args];
		const env: Record<string, string | undefined> = {};
		let binary = input.binary;
		const appendedSystemPrompt = resolveHomeAgentAppendSystemPrompt(input.taskId);

		if (input.autonomousModeEnabled && !hasCliOption(codexArgs, "--dangerously-bypass-approvals-and-sandbox")) {
			codexArgs.push("--dangerously-bypass-approvals-and-sandbox");
		}

		if (input.resumeFromTrash) {
			if (!codexArgs.includes("resume")) {
				codexArgs.push("resume");
			}
			if (!hasCliOption(codexArgs, "--last")) {
				codexArgs.push("--last");
			}
		}

		if (appendedSystemPrompt && !hasCodexConfigOverride(codexArgs, "developer_instructions")) {
			codexArgs.push("-c", `developer_instructions=${JSON.stringify(appendedSystemPrompt)}`);
		}

		const hooks = resolveHookContext(input);
		if (hooks) {
			Object.assign(
				env,
				createHookRuntimeEnv({
					taskId: hooks.taskId,
					workspaceId: hooks.workspaceId,
				}),
			);
		}

		const trimmed = input.prompt.trim();
		if (trimmed) {
			const initialPrompt = input.startInPlanMode ? `/plan\n${trimmed}` : trimmed;
			codexArgs.push(initialPrompt);
		}

		if (hooks) {
			const wrapperParts = buildHooksCommandParts([
				"codex-wrapper",
				"--real-binary",
				input.binary ?? "codex",
				"--",
				...codexArgs,
			]);
			binary = wrapperParts[0];
			const args = wrapperParts.slice(1);
			return {
				binary,
				args,
				env,
				detectOutputTransition: codexPromptDetector,
				shouldInspectOutputForTransition: shouldInspectCodexOutputForTransition,
			};
		}

		return {
			binary,
			args: codexArgs,
			env,
			detectOutputTransition: codexPromptDetector,
			shouldInspectOutputForTransition: shouldInspectCodexOutputForTransition,
		};
	},
};

const ADAPTERS: Partial<Record<RuntimeAgentId, AgentSessionAdapter>> = {
	claude: claudeAdapter,
	codex: codexAdapter,
};

export async function prepareAgentLaunch(input: AgentAdapterLaunchInput): Promise<PreparedAgentLaunch> {
	const adapter = ADAPTERS[input.agentId];
	if (!adapter) {
		throw new Error(`Unsupported agent launch requested: ${input.agentId}`);
	}
	const preparedPrompt = await prepareTaskPromptWithAttachments({
		prompt: input.prompt,
		attachments: input.attachments,
		images: input.images,
		workspaceId: input.workspaceId,
	});
	return await adapter.prepare({
		...input,
		prompt: preparedPrompt,
	});
}
