import type { RuntimeAgentId, RuntimeConfigResponse, RuntimeTaskSessionSummary } from "@/runtime/types";
import type { BoardCard } from "@/types";

export type TaskAgentPreferenceValue = "inherit" | RuntimeAgentId;
export type TaskFallbackAgentPreferenceValue = "inherit" | "none" | RuntimeAgentId;

export interface TaskAgentOption {
	id: RuntimeAgentId;
	label: string;
	installed: boolean;
}

export interface TaskRetryAgentOption extends TaskAgentOption {
	reason: "fallback" | "preferred" | "alternate";
}

const TASK_AGENT_ORDER: readonly RuntimeAgentId[] = ["codex", "claude"];

function sortAgentOptions<T extends { id: RuntimeAgentId }>(options: T[]): T[] {
	const orderIndexById = new Map(TASK_AGENT_ORDER.map((agentId, index) => [agentId, index] as const));
	return [...options].sort((left, right) => {
		return (orderIndexById.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (orderIndexById.get(right.id) ?? Number.MAX_SAFE_INTEGER);
	});
}

export function getTaskAgentOptions(config: RuntimeConfigResponse | null): TaskAgentOption[] {
	if (!config) {
		return [];
	}
	return sortAgentOptions(
		config.agents.map((agent) => ({
			id: agent.id,
			label: agent.label,
			installed: agent.installed,
		})),
	);
}

export function getInstalledTaskAgentOptions(config: RuntimeConfigResponse | null): TaskAgentOption[] {
	return getTaskAgentOptions(config).filter((agent) => agent.installed);
}

export function toTaskAgentPreferenceValue(agentId: RuntimeAgentId | undefined): TaskAgentPreferenceValue {
	return agentId ?? "inherit";
}

export function toTaskFallbackAgentPreferenceValue(
	agentId: RuntimeAgentId | null | undefined,
): TaskFallbackAgentPreferenceValue {
	if (agentId === undefined) {
		return "inherit";
	}
	if (agentId === null) {
		return "none";
	}
	return agentId;
}

export function fromTaskAgentPreferenceValue(value: TaskAgentPreferenceValue): RuntimeAgentId | undefined {
	return value === "inherit" ? undefined : value;
}

export function fromTaskFallbackAgentPreferenceValue(
	value: TaskFallbackAgentPreferenceValue,
): RuntimeAgentId | null | undefined {
	if (value === "inherit") {
		return undefined;
	}
	if (value === "none") {
		return null;
	}
	return value;
}

export function resolveTaskPreferredAgentId(
	card: Pick<BoardCard, "agentId">,
	config: Pick<RuntimeConfigResponse, "selectedAgentId"> | null,
): RuntimeAgentId | null {
	return card.agentId ?? config?.selectedAgentId ?? null;
}

export function resolveTaskFallbackAgentId(
	card: Pick<BoardCard, "agentId" | "fallbackAgentId">,
	config: Pick<RuntimeConfigResponse, "selectedAgentId" | "fallbackAgentId"> | null,
): RuntimeAgentId | null {
	const preferredAgentId = resolveTaskPreferredAgentId(card, config);
	const rawFallbackAgentId = card.fallbackAgentId === undefined ? (config?.fallbackAgentId ?? null) : card.fallbackAgentId;
	if (!rawFallbackAgentId || rawFallbackAgentId === preferredAgentId) {
		return null;
	}
	return rawFallbackAgentId;
}

export function getTaskRetryAgentOptions(
	card: Pick<BoardCard, "agentId" | "fallbackAgentId">,
	summary: Pick<RuntimeTaskSessionSummary, "agentId" | "state"> | null,
	config: RuntimeConfigResponse | null,
): TaskRetryAgentOption[] {
	if (!config || (summary?.state !== "failed" && summary?.state !== "interrupted")) {
		return [];
	}

	const currentAgentId = summary.agentId;
	const preferredAgentId = resolveTaskPreferredAgentId(card, config);
	const fallbackAgentId = resolveTaskFallbackAgentId(card, config);
	const installedOptionsById = new Map(getInstalledTaskAgentOptions(config).map((agent) => [agent.id, agent]));
	const orderedRetryOptions: TaskRetryAgentOption[] = [];
	const addedAgentIds = new Set<RuntimeAgentId>();

	const appendRetryOption = (agentId: RuntimeAgentId | null, reason: TaskRetryAgentOption["reason"]): void => {
		if (!agentId || agentId === currentAgentId || addedAgentIds.has(agentId)) {
			return;
		}
		const option = installedOptionsById.get(agentId);
		if (!option) {
			return;
		}
		addedAgentIds.add(agentId);
		orderedRetryOptions.push({
			...option,
			reason,
		});
	};

	appendRetryOption(fallbackAgentId, "fallback");
	appendRetryOption(preferredAgentId, "preferred");
	for (const option of sortAgentOptions([...installedOptionsById.values()])) {
		appendRetryOption(option.id, "alternate");
	}

	return orderedRetryOptions;
}
