import type { RuntimeSlashCommand } from "../core/api-contract.js";

export interface RuntimeUserInstructionWatcher {
	refreshAll(): Promise<void>;
}

class EmptyWatcher implements RuntimeUserInstructionWatcher {
	async refreshAll(): Promise<void> {}
}

export function createRuntimeUserInstructionWatcher(_workspacePath: string): RuntimeUserInstructionWatcher {
	return new EmptyWatcher();
}

export function listRuntimeWorkflowSlashCommands(
	_watcher?: RuntimeUserInstructionWatcher,
): RuntimeSlashCommand[] {
	return [];
}
