import type { RuntimeSlashCommand } from "../core/api-contract.js";

export interface RuntimeSdkUserInstructionWatcher {
	refreshAll(): Promise<void>;
}

class EmptyWatcher implements RuntimeSdkUserInstructionWatcher {
	async refreshAll(): Promise<void> {}
}

export function createRuntimeSdkUserInstructionWatcher(_workspacePath: string): RuntimeSdkUserInstructionWatcher {
	return new EmptyWatcher();
}

export function listRuntimeWorkflowSlashCommands(
	_watcher?: RuntimeSdkUserInstructionWatcher,
): RuntimeSlashCommand[] {
	return [];
}

export type ClineSdkUserInstructionWatcher = RuntimeSdkUserInstructionWatcher;
export { createRuntimeSdkUserInstructionWatcher as createClineSdkUserInstructionWatcher };
export { listRuntimeWorkflowSlashCommands as listClineSdkWorkflowSlashCommands };
