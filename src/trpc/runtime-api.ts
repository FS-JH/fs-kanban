// Coordinates the runtime-side TRPC handlers used by the browser.
// This is the main backend entrypoint for sessions, settings, git, and
// workspace actions, but detailed agent, terminal, and config behavior
// should stay in focused services instead of accumulating here.

import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { TRPCError } from "@trpc/server";
import { createRuntimeMcpRuntimeService } from "../cline-sdk/cline-mcp-runtime-service.js";
import { createClineMcpSettingsService } from "../cline-sdk/cline-mcp-settings-service.js";
import { createRuntimeProviderService } from "../cline-sdk/cline-provider-service.js";
import type { TaskSessionService } from "../cline-sdk/cline-task-session-service.js";
import {
	createRuntimeSdkUserInstructionWatcher,
	listRuntimeWorkflowSlashCommands,
} from "../cline-sdk/sdk-runtime-boundary.js";
import type { RuntimeConfigState } from "../config/runtime-config.js";
import { updateGlobalRuntimeConfig, updateRuntimeConfig } from "../config/runtime-config.js";
import type { RuntimeCommandRunResponse } from "../core/api-contract.js";
import {
	parseMcpOAuthRequest,
	parseMcpSettingsSaveRequest,
	parseOauthLoginRequest,
	parseProviderModelsRequest,
	parseProviderSettingsSaveRequest,
	parseCommandRunRequest,
	parseRuntimeConfigSaveRequest,
	parseShellSessionStartRequest,
	parseTaskChatAbortRequest,
	parseTaskChatReloadRequest,
	parseTaskChatCancelRequest,
	parseTaskChatMessagesRequest,
	parseTaskChatSendRequest,
	parseTaskSessionInputRequest,
	parseTaskSessionStartRequest,
	parseTaskSessionStopRequest,
} from "../core/api-validation.js";
import { isHomeAgentSessionId } from "../core/home-agent-session.js";
import { openInBrowser } from "../server/browser.js";
import { buildRuntimeConfigResponse, resolveAgentCommand } from "../terminal/agent-registry.js";
import type { TerminalSessionManager } from "../terminal/session-manager.js";
import { resolveTaskCwd } from "../workspace/task-worktree.js";
import { captureTaskTurnCheckpoint } from "../workspace/turn-checkpoints.js";
import type { RuntimeTrpcContext, RuntimeTrpcWorkspaceScope } from "./app-router.js";

export interface CreateRuntimeApiDependencies {
	getActiveWorkspaceId: () => string | null;
	getActiveRuntimeConfig?: () => RuntimeConfigState;
	loadScopedRuntimeConfig: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeConfigState>;
	setActiveRuntimeConfig: (config: RuntimeConfigState) => void;
	getScopedTerminalManager: (scope: RuntimeTrpcWorkspaceScope) => Promise<TerminalSessionManager>;
	getScopedTaskSessionService?: (scope: RuntimeTrpcWorkspaceScope) => Promise<TaskSessionService>;
	resolveInteractiveShellCommand: () => { binary: string; args: string[] };
	runCommand: (command: string, cwd: string) => Promise<RuntimeCommandRunResponse>;
	broadcastMcpAuthStatusesUpdated?: (
		statuses: Awaited<ReturnType<ReturnType<typeof createRuntimeMcpRuntimeService>["getAuthStatuses"]>>,
	) => void;
	bumpSessionContextVersion?: () => void;
	prepareForStateReset?: () => Promise<void>;
}

const LEGACY_NATIVE_AGENT_REMOVAL_MESSAGE =
	"Native agent support has been removed from FS Kanban. Choose Codex or Claude in Settings.";

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
	const providerService = createRuntimeProviderService();
	const mcpSettingsService = createClineMcpSettingsService();
	const mcpRuntimeService = createRuntimeMcpRuntimeService({
		onAuthStatusesChanged: (statuses) => {
			deps.broadcastMcpAuthStatusesUpdated?.(statuses);
		},
	});
	const debugResetTargetPaths = [
		join(homedir(), ".config", "fs-kanban"),
		join(homedir(), ".config", "fs-kanban", "worktrees"),
		join(homedir(), ".config", "fs-kanban", "data"),
	] as const;

	const buildConfigResponse = (runtimeConfig: RuntimeConfigState) =>
		buildRuntimeConfigResponse(runtimeConfig, providerService.getProviderSettingsSummary());
	const getTaskSessionService = async (workspaceScope: RuntimeTrpcWorkspaceScope): Promise<TaskSessionService> => {
		const service = deps.getScopedTaskSessionService;
		if (!service) {
			throw new Error("No task session service is available.");
		}
		return await service(workspaceScope);
	};

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
		saveProviderSettings: async (_workspaceScope, input) => {
			const body = parseProviderSettingsSaveRequest(input);
			return providerService.saveProviderSettings(body);
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

				if (scopedRuntimeConfig.selectedAgentId === "cline") {
					return {
						ok: false,
						summary: null,
						error: LEGACY_NATIVE_AGENT_REMOVAL_MESSAGE,
					};
				}

				const resolved = resolveAgentCommand(scopedRuntimeConfig);
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
					autonomousModeEnabled: scopedRuntimeConfig.agentAutonomousModeEnabled,
					cwd: taskCwd,
					prompt: body.prompt,
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
				const taskSessionService = await getTaskSessionService(workspaceScope);
				const taskSummary = await taskSessionService.stopTaskSession(body.taskId);
				if (taskSummary) {
					return {
						ok: true,
						summary: taskSummary,
					};
				}
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
				const payloadText = body.appendNewline ? `${body.text}\n` : body.text;
				const taskSessionService = await getTaskSessionService(workspaceScope);
				const taskSummary = await taskSessionService.sendTaskSessionInput(body.taskId, payloadText);
				if (taskSummary) {
					return {
						ok: true,
						summary: taskSummary,
					};
				}
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
		getTaskChatMessages: async (workspaceScope, input) => {
			try {
				const body = parseTaskChatMessagesRequest(input);
				const taskSessionService = await getTaskSessionService(workspaceScope);
				const summary = taskSessionService.getSummary(body.taskId);
				const messages = await taskSessionService.loadTaskSessionMessages(body.taskId);
				if (!summary && messages.length === 0) {
					return {
						ok: false,
						messages: [],
						error: "Task chat session is not available.",
					};
				}
				return {
					ok: true,
					messages,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					messages: [],
					error: message,
				};
			}
		},
		getSlashCommands: async (workspaceScope) => {
			const watcher = workspaceScope
				? createRuntimeSdkUserInstructionWatcher(workspaceScope.workspacePath)
				: undefined;
			if (watcher) {
				await watcher.refreshAll();
			}
			return {
				commands: listRuntimeWorkflowSlashCommands(watcher),
			};
		},
		reloadTaskChatSession: async (workspaceScope, input) => {
			try {
				const body = parseTaskChatReloadRequest(input);
				const taskSessionService = await getTaskSessionService(workspaceScope);
				const summary = await taskSessionService.reloadTaskSession(body.taskId);
				if (!summary) {
					return {
						ok: false,
						summary: null,
						error: "Task chat session is not available.",
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
		abortTaskChatTurn: async (workspaceScope, input) => {
			try {
				const body = parseTaskChatAbortRequest(input);
				const taskSessionService = await getTaskSessionService(workspaceScope);
				const summary = await taskSessionService.abortTaskSession(body.taskId);
				if (!summary) {
					return {
						ok: false,
						summary: null,
						error: "Task chat session is not running.",
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
		cancelTaskChatTurn: async (workspaceScope, input) => {
			try {
				const body = parseTaskChatCancelRequest(input);
				const taskSessionService = await getTaskSessionService(workspaceScope);
				const summary = await taskSessionService.cancelTaskTurn(body.taskId);
				if (!summary) {
					return {
						ok: false,
						summary: null,
						error: "Task chat session turn is not running.",
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
		getProviderCatalog: async (_workspaceScope) => {
			return await providerService.getProviderCatalog();
		},
		getAccountProfile: async (_workspaceScope) => {
			return await providerService.getAccountProfile();
		},
		getKanbanAccess: async (_workspaceScope) => {
			return await providerService.getKanbanAccess();
		},
		getProviderModels: async (_workspaceScope, input) => {
			const body = parseProviderModelsRequest(input);
			return await providerService.getProviderModels(body.providerId);
		},
		getMcpAuthStatuses: async (_workspaceScope) => {
			const statuses = await mcpRuntimeService.getAuthStatuses();
			return {
				statuses,
			};
		},
		runMcpServerOAuth: async (_workspaceScope, input) => {
			const body = parseMcpOAuthRequest(input);
			const response = await mcpRuntimeService.authorizeServer({
				serverName: body.serverName,
				onAuthorizationUrl: (url: string) => {
					openInBrowser(url);
				},
			});
			deps.bumpSessionContextVersion?.();
			return response;
		},
		getMcpSettings: async (_workspaceScope) => {
			return mcpSettingsService.loadSettings();
		},
		saveMcpSettings: async (_workspaceScope, input) => {
			const body = parseMcpSettingsSaveRequest(input);
			const response = await mcpSettingsService.saveSettings(body);
			deps.bumpSessionContextVersion?.();
			return response;
		},
		runProviderOAuthLogin: async (_workspaceScope, input) => {
			const body = parseOauthLoginRequest(input);
			return await providerService.runOauthLogin({
				providerId: body.provider,
				baseUrl: body.baseUrl,
			});
		},
		sendTaskChatMessage: async (workspaceScope, input) => {
			try {
				const body = parseTaskChatSendRequest(input);
				const requestedMode = body.mode;
				const taskSessionService = await getTaskSessionService(workspaceScope);
				let summary = await taskSessionService.sendTaskSessionInput(
					body.taskId,
					body.text,
					requestedMode,
					body.images,
				);
				if (!summary) {
					if (!isHomeAgentSessionId(body.taskId)) {
						const reboundSummary = await taskSessionService.rebindPersistedTaskSession(body.taskId);
						if (reboundSummary) {
							summary = await taskSessionService.sendTaskSessionInput(
								body.taskId,
								body.text,
								requestedMode,
								body.images,
							);
						}
						if (!summary) {
							return {
								ok: false,
								summary: null,
								error: "Task chat session is not running.",
							};
						}
					} else {
						return {
							ok: false,
							summary: null,
							error: LEGACY_NATIVE_AGENT_REMOVAL_MESSAGE,
						};
					}
				}
				const latestMessage = taskSessionService.listMessages(body.taskId).at(-1) ?? null;
				return {
					ok: true,
					summary,
					message: latestMessage,
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
		};
}
