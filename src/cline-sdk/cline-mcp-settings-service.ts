import { homedir } from "node:os";
import { join } from "node:path";

import type {
	RuntimeClineMcpSettingsResponse,
	RuntimeClineMcpSettingsSaveRequest,
	RuntimeClineMcpSettingsSaveResponse,
} from "../core/api-contract.js";

function getDisabledSettingsPath(): string {
	return join(homedir(), ".config", "fs-kanban", "cline-mcp.disabled.json");
}

export function createClineMcpSettingsService() {
	return {
		async loadSettings(): Promise<RuntimeClineMcpSettingsResponse> {
			return {
				path: getDisabledSettingsPath(),
				servers: [],
			};
		},
		async saveSettings(input: RuntimeClineMcpSettingsSaveRequest): Promise<RuntimeClineMcpSettingsSaveResponse> {
			return {
				path: getDisabledSettingsPath(),
				servers: input.servers ?? [],
			};
		},
	};
}
