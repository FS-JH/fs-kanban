import type {
	RuntimeConfigResponse,
} from "@/runtime/types";
import { isRuntimeAgentLaunchSupported } from "@runtime-agent-catalog";

export function isTaskAgentSetupSatisfied(
	config: Pick<RuntimeConfigResponse, "agents"> | null | undefined,
): boolean | null {
	if (!config) {
		return null;
	}
	return config.agents.some((agent) => isRuntimeAgentLaunchSupported(agent.id) && agent.installed);
}

export function getTaskAgentNavbarHint(
	config: Pick<RuntimeConfigResponse, "agents"> | null | undefined,
	options?: {
		shouldUseNavigationPath?: boolean;
	},
): string | undefined {
	if (options?.shouldUseNavigationPath) {
		return undefined;
	}
	const isTaskAgentReady = isTaskAgentSetupSatisfied(config);
	if (isTaskAgentReady === null || isTaskAgentReady) {
		return undefined;
	}
	return "No agent configured";
}
