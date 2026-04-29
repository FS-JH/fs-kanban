import type { RuntimeConfigState } from "../config/runtime-config.js";
import { getRuntimeLaunchSupportedAgentCatalog, RUNTIME_AGENT_CATALOG } from "../core/agent-catalog.js";
import type { RuntimeAgentDefinition, RuntimeAgentId, RuntimeConfigResponse } from "../core/api-contract.js";
import { isBinaryAvailableOnPath, resolveBinaryLocation } from "./command-discovery.js";

export interface ResolvedAgentCommand {
	agentId: RuntimeAgentId;
	label: string;
	command: string;
	binary: string;
	args: string[];
}

function getDefaultArgs(agentId: RuntimeAgentId): string[] {
	const entry = RUNTIME_AGENT_CATALOG.find((candidate) => candidate.id === agentId);
	if (!entry) {
		return [];
	}
	return [...entry.baseArgs];
}

function quoteForDisplay(part: string): string {
	if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(part)) {
		return part;
	}
	return JSON.stringify(part);
}

function joinCommand(binary: string, args: string[]): string {
	if (args.length === 0) {
		return binary;
	}
	return [binary, ...args.map(quoteForDisplay)].join(" ");
}

function parseBooleanEnvValue(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isRuntimeDebugModeEnabled(): boolean {
	const debugModeValue = process.env.KANBAN_DEBUG_MODE ?? process.env.DEBUG_MODE ?? process.env.debug_mode;
	return parseBooleanEnvValue(debugModeValue);
}

// When KANBAN_DISABLE_TRASH_ON_INTERRUPT=1 is set, the frontend will NOT
// auto-move a task to the trash column when its session transitions to
// "interrupted". The card stays in its current column with state="interrupted"
// so the user can resume in place via the existing "Start" flow. Designed for
// headless / pm2-managed deployments where pm2 restarts and external kills
// would otherwise evict in-progress work.
function isTrashOnInterruptDisabled(): boolean {
	return parseBooleanEnvValue(process.env.KANBAN_DISABLE_TRASH_ON_INTERRUPT);
}

export function detectInstalledCommands(): string[] {
	const candidates = [...RUNTIME_AGENT_CATALOG.map((entry) => entry.binary), "npx"];
	const detected: string[] = [];

	for (const candidate of candidates) {
		if (isBinaryAvailableOnPath(candidate)) {
			detected.push(candidate);
		}
	}

	return detected;
}

function getCuratedDefinitions(runtimeConfig: RuntimeConfigState, detected: string[]): RuntimeAgentDefinition[] {
	const detectedSet = new Set(detected);
	return getRuntimeLaunchSupportedAgentCatalog().map((entry) => {
		const defaultArgs = getDefaultArgs(entry.id);
		const command = joinCommand(entry.binary, defaultArgs);
		return {
			id: entry.id,
			label: entry.label,
			binary: entry.binary,
			command,
			defaultArgs,
			installed: detectedSet.has(entry.binary),
			configured: runtimeConfig.selectedAgentId === entry.id,
		};
	});
}

export function resolveAgentCommand(
	runtimeConfig: RuntimeConfigState,
	requestedAgentId?: RuntimeAgentId | null,
): ResolvedAgentCommand | null {
	const targetAgentId = requestedAgentId ?? runtimeConfig.selectedAgentId;
	const selected = getRuntimeLaunchSupportedAgentCatalog().find((entry) => entry.id === targetAgentId);
	if (!selected) {
		return null;
	}
	const defaultArgs = getDefaultArgs(selected.id);
	const command = joinCommand(selected.binary, defaultArgs);
	const resolvedBinary = resolveBinaryLocation(selected.binary);
	if (resolvedBinary) {
		return {
			agentId: selected.id,
			label: selected.label,
			command,
			binary: resolvedBinary,
			args: defaultArgs,
		};
	}
	return null;
}

export function buildRuntimeConfigResponse(runtimeConfig: RuntimeConfigState): RuntimeConfigResponse {
	const detectedCommands = detectInstalledCommands();
	const agents = getCuratedDefinitions(runtimeConfig, detectedCommands);
	const resolved = resolveAgentCommand(runtimeConfig);
	const effectiveCommand = resolved ? resolved.command : null;

	return {
		selectedAgentId: runtimeConfig.selectedAgentId,
		fallbackAgentId: runtimeConfig.fallbackAgentId,
		selectedShortcutLabel: runtimeConfig.selectedShortcutLabel,
		agentApprovalMode: runtimeConfig.agentApprovalMode,
		agentAutonomousModeEnabled: runtimeConfig.agentAutonomousModeEnabled,
		agentAttentionNotificationsEnabled: runtimeConfig.agentAttentionNotificationsEnabled,
		agentAttentionSoundEnabled: runtimeConfig.agentAttentionSoundEnabled,
		debugModeEnabled: isRuntimeDebugModeEnabled(),
		trashOnInterruptDisabled: isTrashOnInterruptDisabled(),
		effectiveCommand,
		globalConfigPath: runtimeConfig.globalConfigPath,
		projectConfigPath: runtimeConfig.projectConfigPath,
		readyForReviewNotificationsEnabled: runtimeConfig.readyForReviewNotificationsEnabled,
		detectedCommands,
		agents,
		shortcuts: runtimeConfig.shortcuts,
		commitPromptTemplate: runtimeConfig.commitPromptTemplate,
		openPrPromptTemplate: runtimeConfig.openPrPromptTemplate,
		commitPromptTemplateDefault: runtimeConfig.commitPromptTemplateDefault,
		openPrPromptTemplateDefault: runtimeConfig.openPrPromptTemplateDefault,
	};
}
