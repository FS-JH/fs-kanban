import type {
	RuntimeClineAccountProfileResponse,
	RuntimeClineKanbanAccessResponse,
	RuntimeClineOauthLoginResponse,
	RuntimeClineOauthProvider,
	RuntimeClineProviderCatalogResponse,
	RuntimeClineProviderModelsResponse,
	RuntimeClineProviderSettings,
	RuntimeClineProviderSettingsSaveRequest,
} from "../core/api-contract.js";

const REMOVAL_MESSAGE = "Native Cline support has been removed from FS Kanban.";

const EMPTY_PROVIDER_SETTINGS: RuntimeClineProviderSettings = {
	providerId: null,
	modelId: null,
	baseUrl: null,
	reasoningEffort: null,
	apiKeyConfigured: false,
	oauthProvider: null,
	oauthAccessTokenConfigured: false,
	oauthRefreshTokenConfigured: false,
	oauthAccountId: null,
	oauthExpiresAt: null,
};

function normalizeProviderOauthProvider(value: string): RuntimeClineOauthProvider {
	if (value === "cline" || value === "oca" || value === "openai-codex") {
		return value;
	}
	return "cline";
}

export function createRuntimeProviderService() {
	return {
		getProviderSettingsSummary(): RuntimeClineProviderSettings {
			return { ...EMPTY_PROVIDER_SETTINGS };
		},
		saveProviderSettings(_input: RuntimeClineProviderSettingsSaveRequest): RuntimeClineProviderSettings {
			return { ...EMPTY_PROVIDER_SETTINGS };
		},
		async resolveLaunchConfig(): Promise<{
			providerId: string;
			modelId: string;
			apiKey: string | null;
			baseUrl: string | null;
			reasoningEffort: null;
		}> {
			throw new Error(REMOVAL_MESSAGE);
		},
		async getProviderCatalog(): Promise<RuntimeClineProviderCatalogResponse> {
			return {
				providers: [],
			};
		},
		async getAccountProfile(): Promise<RuntimeClineAccountProfileResponse> {
			return {
				profile: null,
			};
		},
		async getKanbanAccess(): Promise<RuntimeClineKanbanAccessResponse> {
			return {
				enabled: true,
			};
		},
		async getProviderModels(providerId: string): Promise<RuntimeClineProviderModelsResponse> {
			return {
				providerId,
				models: [],
			};
		},
		async runOauthLogin(input: { providerId: string; baseUrl?: string | null }): Promise<RuntimeClineOauthLoginResponse> {
			return {
				ok: false,
				provider: normalizeProviderOauthProvider(input.providerId),
				error: REMOVAL_MESSAGE,
			};
		},
	};
}

export { createRuntimeProviderService as createClineProviderService };
