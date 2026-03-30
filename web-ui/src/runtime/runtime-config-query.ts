// Browser-side query helpers for runtime settings and agent-provider actions.
// Keep TRPC request details here so components and controller hooks can focus
// on state orchestration instead of transport plumbing.
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeAgentId,
	RuntimeClineMcpAuthStatusResponse,
	RuntimeClineAccountProfileResponse,
	RuntimeClineKanbanAccessResponse,
	RuntimeClineMcpOAuthResponse,
	RuntimeClineMcpServer,
	RuntimeClineMcpSettingsResponse,
	RuntimeClineOauthLoginResponse,
	RuntimeClineOauthProvider,
	RuntimeClineProviderCatalogItem,
	RuntimeClineProviderModel,
	RuntimeClineReasoningEffort,
	RuntimeClineProviderSettings,
	RuntimeConfigResponse,
	RuntimeDebugResetAllStateResponse,
	RuntimeProjectShortcut,
} from "@/runtime/types";

export async function fetchRuntimeConfig(workspaceId: string | null): Promise<RuntimeConfigResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.getConfig.query();
}

export async function saveRuntimeConfig(
	workspaceId: string | null,
	nextConfig: {
		selectedAgentId?: RuntimeAgentId;
		selectedShortcutLabel?: string | null;
		agentAutonomousModeEnabled?: boolean;
		shortcuts?: RuntimeProjectShortcut[];
		readyForReviewNotificationsEnabled?: boolean;
		commitPromptTemplate?: string;
		openPrPromptTemplate?: string;
	},
): Promise<RuntimeConfigResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.saveConfig.mutate(nextConfig);
}

export async function saveAgentProviderSettings(
	workspaceId: string | null,
	input: {
		providerId: string;
		modelId?: string | null;
		apiKey?: string | null;
		baseUrl?: string | null;
		reasoningEffort?: RuntimeClineReasoningEffort | null;
	},
): Promise<RuntimeClineProviderSettings> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.saveProviderSettings.mutate(input);
}

export async function fetchAgentProviderCatalog(workspaceId: string | null): Promise<RuntimeClineProviderCatalogItem[]> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	const response = await trpcClient.runtime.getProviderCatalog.query();
	return response.providers;
}

export async function fetchAgentAccountProfile(workspaceId: string | null): Promise<RuntimeClineAccountProfileResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.getAccountProfile.query();
}

export async function fetchAgentKanbanAccess(workspaceId: string | null): Promise<RuntimeClineKanbanAccessResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.getKanbanAccess.query();
}

export async function fetchAgentProviderModels(
	workspaceId: string | null,
	providerId: string,
): Promise<RuntimeClineProviderModel[]> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	const response = await trpcClient.runtime.getProviderModels.query({ providerId });
	return response.models;
}

export async function runAgentProviderOauthLogin(
	workspaceId: string | null,
	input: {
		provider: RuntimeClineOauthProvider;
		baseUrl?: string | null;
	},
): Promise<RuntimeClineOauthLoginResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.runProviderOAuthLogin.mutate(input);
}

export async function fetchAgentMcpSettings(workspaceId: string | null): Promise<RuntimeClineMcpSettingsResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.getMcpSettings.query();
}

export async function fetchAgentMcpAuthStatuses(workspaceId: string | null): Promise<RuntimeClineMcpAuthStatusResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.getMcpAuthStatuses.query();
}

export async function saveAgentMcpSettings(
	workspaceId: string | null,
	input: {
		servers: RuntimeClineMcpServer[];
	},
): Promise<RuntimeClineMcpSettingsResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.saveMcpSettings.mutate(input);
}

export async function runAgentMcpServerOAuth(
	workspaceId: string | null,
	input: {
		serverName: string;
	},
): Promise<RuntimeClineMcpOAuthResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.runMcpServerOAuth.mutate(input);
}

export async function resetRuntimeDebugState(workspaceId: string | null): Promise<RuntimeDebugResetAllStateResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.resetAllState.mutate();
}

export async function openFileOnHost(workspaceId: string | null, filePath: string): Promise<void> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	await trpcClient.runtime.openFile.mutate({ filePath });
}
