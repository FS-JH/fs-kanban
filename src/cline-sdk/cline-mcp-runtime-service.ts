import type { RuntimeClineMcpOAuthResponse, RuntimeClineMcpServerAuthStatus } from "../core/api-contract.js";

const REMOVAL_MESSAGE = "Native Cline MCP support has been removed from FS Kanban.";

export async function handleRuntimeMcpOauthCallback(
	_requestUrl: URL,
): Promise<{ statusCode: number; body: string } | null> {
	return null;
}

export function createRuntimeMcpRuntimeService(_options?: {
	onAuthStatusesChanged?: (statuses: RuntimeClineMcpServerAuthStatus[]) => void;
}) {
	return {
		async getAuthStatuses(): Promise<RuntimeClineMcpServerAuthStatus[]> {
			return [];
		},
		async authorizeServer(input: {
			serverName: string;
			onAuthorizationUrl?: (url: string) => void;
		}): Promise<RuntimeClineMcpOAuthResponse> {
			throw new Error(`${REMOVAL_MESSAGE} (${input.serverName})`);
		},
	};
}

export { handleRuntimeMcpOauthCallback as handleClineMcpOauthCallback };
export { createRuntimeMcpRuntimeService as createClineMcpRuntimeService };
