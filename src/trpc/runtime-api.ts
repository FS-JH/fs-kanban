// Coordinates the runtime-side TRPC handlers used by the browser.
// This is the main backend entrypoint for sessions, settings, git, and
// workspace actions, but detailed agent, terminal, and config behavior
// should stay in focused services instead of accumulating here.

import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { TRPCError } from "@trpc/server";
import type { RuntimeConfigState } from "../config/runtime-config.js";
import { updateGlobalRuntimeConfig, updateRuntimeConfig } from "../config/runtime-config.js";
import type { RuntimeCommandRunResponse } from "../core/api-contract.js";
import {
	parseCommandRunRequest,
	parseRuntimeConfigSaveRequest,
	parseShellSessionStartRequest,
	parseTaskSessionInputRequest,
	parseTaskSessionStartRequest,
	parseTaskSessionStopRequest,
} from "../core/api-validation.js";
import { isHomeAgentSessionId } from "../core/home-agent-session.js";
import {
	createRuntimeUserInstructionWatcher,
	listRuntimeWorkflowSlashCommands,
} from "../runtime/sdk-user-instructions.js";
import { openInBrowser } from "../server/browser.js";
import { buildRuntimeConfigResponse, resolveAgentCommand } from "../terminal/agent-registry.js";
import type { TerminalSessionManager } from "../terminal/session-manager.js";
import type { SupervisorApprovalQueue } from "../terminal/supervisor-approval-queue.js";
import { resolveTaskCwd } from "../workspace/task-worktree.js";
import { captureTaskTurnCheckpoint } from "../workspace/turn-checkpoints.js";
import type { RuntimeTrpcContext, RuntimeTrpcWorkspaceScope } from "./app-router.js";

export interface CreateRuntimeApiDependencies {
	getActiveWorkspaceId: () => string | null;
	getActiveRuntimeConfig?: () => RuntimeConfigState;
	loadScopedRuntimeConfig: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeConfigState>;
	setActiveRuntimeConfig: (config: RuntimeConfigState) => void;
	getScopedTerminalManager: (scope: RuntimeTrpcWorkspaceScope) => Promise<TerminalSessionManager>;
	getTerminalManagerForWorkspace?: (workspaceId: string) => TerminalSessionManager | null;
	resolveInteractiveShellCommand: () => { binary: string; args: string[] };
	runCommand: (command: string, cwd: string) => Promise<RuntimeCommandRunResponse>;
	prepareForStateReset?: () => Promise<void>;
	approvalQueue?: SupervisorApprovalQueue;
}

async function resolveExistingTaskCwdOrEnsure(options: {
	cwd: string;
	taskId: string;
	baseRef: string;
}): Promise<string> {
	try {
		return await resolveTaskCwd({
			cwd: options.cwd,
			taskId: options.taskId,
			baseRef: options.baseRef,
			ensure: false,
		});
	} catch {
		return await resolveTaskCwd({
			cwd: options.cwd,
			taskId: options.taskId,
			baseRef: options.baseRef,
			ensure: true,
		});
	}
}

export function createRuntimeApi(deps: CreateRuntimeApiDependencies): RuntimeTrpcContext["runtimeApi"] {
	const debugResetTargetPaths = [
		join(homedir(), ".config", "fs-kanban"),
		join(homedir(), ".config", "fs-kanban", "worktrees"),
		join(homedir(), ".config", "fs-kanban", "data"),
	] as const;

	const buildConfigResponse = (runtimeConfig: RuntimeConfigState) => buildRuntimeConfigResponse(runtimeConfig);

	return {
		loadConfig: async (workspaceScope) => {
			const activeRuntimeConfig = deps.getActiveRuntimeConfig?.();
			if (!workspaceScope && !activeRuntimeConfig) {
				throw new Error("No active runtime config provider is available.");
			}
			let scopedRuntimeConfig: RuntimeConfigState;
			if (workspaceScope) {
				scopedRuntimeConfig = await deps.loadScopedRuntimeConfig(workspaceScope);
			} else if (activeRuntimeConfig) {
				scopedRuntimeConfig = activeRuntimeConfig;
			} else {
				throw new Error("No active runtime config provider is available.");
			}
			return buildConfigResponse(scopedRuntimeConfig);
		},
		saveConfig: async (workspaceScope, input) => {
			const parsed = parseRuntimeConfigSaveRequest(input);
			let nextRuntimeConfig: RuntimeConfigState;
			if (workspaceScope) {
				nextRuntimeConfig = await updateRuntimeConfig(workspaceScope.workspacePath, parsed);
			} else {
				const activeRuntimeConfig = deps.getActiveRuntimeConfig?.();
				if (!activeRuntimeConfig) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "No active runtime config is available.",
					});
				}
				nextRuntimeConfig = await updateGlobalRuntimeConfig(activeRuntimeConfig, parsed);
			}
			if (workspaceScope && workspaceScope.workspaceId === deps.getActiveWorkspaceId()) {
				deps.setActiveRuntimeConfig(nextRuntimeConfig);
			}
			if (!workspaceScope) {
				deps.setActiveRuntimeConfig(nextRuntimeConfig);
			}
			return buildConfigResponse(nextRuntimeConfig);
		},
		startTaskSession: async (workspaceScope, input) => {
			try {
				const body = parseTaskSessionStartRequest(input);
				const scopedRuntimeConfig = await deps.loadScopedRuntimeConfig(workspaceScope);
				const taskCwd = isHomeAgentSessionId(body.taskId)
					? workspaceScope.workspacePath
					: await resolveExistingTaskCwdOrEnsure({
							cwd: workspaceScope.workspacePath,
							taskId: body.taskId,
							baseRef: body.baseRef,
						});
				const shouldCaptureTurnCheckpoint = !body.resumeFromTrash && !isHomeAgentSessionId(body.taskId);

				const resolved = resolveAgentCommand(scopedRuntimeConfig, body.agentId);
				if (!resolved) {
					return {
						ok: false,
						summary: null,
						error: "No runnable agent command is configured. Open Settings, install a supported CLI, and select it.",
					};
				}
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const summary = await terminalManager.startTaskSession({
					taskId: body.taskId,
					agentId: resolved.agentId,
					binary: resolved.binary,
					args: resolved.args,
					approvalMode: scopedRuntimeConfig.agentApprovalMode,
					autonomousModeEnabled: scopedRuntimeConfig.agentAutonomousModeEnabled,
					cwd: taskCwd,
					prompt: body.prompt,
					attachments: body.attachments,
					images: body.images,
					startInPlanMode: body.startInPlanMode,
					resumeFromTrash: body.resumeFromTrash,
					cols: body.cols,
					rows: body.rows,
					workspaceId: workspaceScope.workspaceId,
				});

				let nextSummary = summary;
				if (shouldCaptureTurnCheckpoint) {
					try {
						const nextTurn = (summary.latestTurnCheckpoint?.turn ?? 0) + 1;
						const checkpoint = await captureTaskTurnCheckpoint({
							cwd: taskCwd,
							taskId: body.taskId,
							turn: nextTurn,
						});
						nextSummary = terminalManager.applyTurnCheckpoint(body.taskId, checkpoint) ?? summary;
					} catch {
						// Best effort checkpointing only.
					}
				}
				return {
					ok: true,
					summary: nextSummary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		stopTaskSession: async (workspaceScope, input) => {
			try {
				const body = parseTaskSessionStopRequest(input);
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const summary = terminalManager.stopTaskSession(body.taskId);
				return {
					ok: Boolean(summary),
					summary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		sendTaskSessionInput: async (workspaceScope, input) => {
			try {
				const body = parseTaskSessionInputRequest(input);
				// TUIs (codex, claude) submit on CR not LF — sending "\n" alone
				// inserts a literal newline in the input box without submitting.
				// "\r" gets the prompt to fire.
				const payloadText = body.appendNewline ? `${body.text}\r` : body.text;
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const summary = terminalManager.writeInput(body.taskId, Buffer.from(payloadText, "utf8"));
				if (!summary) {
					return {
						ok: false,
						summary: null,
						error: "Task session is not running.",
					};
				}
				return {
					ok: true,
					summary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		getSlashCommands: async (workspaceScope) => {
			const watcher = workspaceScope ? createRuntimeUserInstructionWatcher(workspaceScope.workspacePath) : undefined;
			if (watcher) {
				await watcher.refreshAll();
			}
			return {
				commands: listRuntimeWorkflowSlashCommands(watcher),
			};
		},
		startShellSession: async (workspaceScope, input) => {
			try {
				const body = parseShellSessionStartRequest(input);
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const shell = deps.resolveInteractiveShellCommand();
				const shellCwd = body.workspaceTaskId
					? await resolveTaskCwd({
							cwd: workspaceScope.workspacePath,
							taskId: body.workspaceTaskId,
							baseRef: body.baseRef,
							ensure: true,
						})
					: workspaceScope.workspacePath;
				const summary = await terminalManager.startShellSession({
					taskId: body.taskId,
					cwd: shellCwd,
					cols: body.cols,
					rows: body.rows,
					binary: shell.binary,
					args: shell.args,
				});
				return {
					ok: true,
					summary,
					shellBinary: shell.binary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					shellBinary: null,
					error: message,
				};
			}
		},
		runCommand: async (workspaceScope, input) => {
			try {
				const body = parseCommandRunRequest(input);
				return await deps.runCommand(body.command, workspaceScope.workspacePath);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message,
				});
			}
		},
		resetAllState: async (_workspaceScope) => {
			await deps.prepareForStateReset?.();
			await Promise.all(
				debugResetTargetPaths.map(async (path) => {
					await rm(path, { recursive: true, force: true });
				}),
			);
			return {
				ok: true,
				clearedPaths: [...debugResetTargetPaths],
			};
		},
		openFile: async (input) => {
			const filePath = input.filePath.trim();
			if (!filePath) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "File path cannot be empty.",
				});
			}
			openInBrowser(filePath);
			return { ok: true };
		},
		listApprovals: async (input) => {
			const queue = deps.approvalQueue;
			if (!queue) {
				return { pending: [], recent: [] };
			}
			const all = queue.byWorkspace(input.workspaceId);
			const pending = all.filter((entry) => entry.status === "pending");
			const recent = all
				.filter((entry) => entry.status !== "pending")
				.sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0))
				.slice(0, 50);
			return { pending: [...pending], recent: [...recent] };
		},
		decideApproval: async (input) => {
			const queue = deps.approvalQueue;
			if (!queue) {
				throw new TRPCError({ code: "NOT_FOUND", message: "Approval queue not available." });
			}
			const request = queue.get(input.requestId);
			if (!request || request.workspaceId !== input.workspaceId) {
				throw new TRPCError({ code: "NOT_FOUND", message: "Approval request not found." });
			}
			const manager = deps.getTerminalManagerForWorkspace?.(input.workspaceId) ?? null;
			if (!manager) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Workspace runtime is not active; restart the workspace and try again.",
				});
			}
			const updated = manager.applyDecision(input.requestId, input.decision);
			if (!updated) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Approval request is no longer actionable.",
				});
			}
			return updated;
		},
		listApprovalHistory: async (input) => {
			const queue = deps.approvalQueue;
			if (!queue) return [];
			const all = queue.byWorkspace(input.workspaceId);
			const decided = all
				.filter((entry) => entry.status !== "pending")
				.sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0));
			const limit = input.limit ?? 100;
			return decided.slice(0, limit).map((entry) => ({ ...entry }));
		},
	};
}
