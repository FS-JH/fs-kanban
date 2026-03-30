import type {
	RuntimeClineReasoningEffort,
	RuntimeTaskChatMessage,
	RuntimeTaskImage,
	RuntimeTaskSessionMode,
	RuntimeTaskSessionSummary,
	RuntimeTaskTurnCheckpoint,
} from "../core/api-contract.js";

export type TaskMessage = RuntimeTaskChatMessage;

export interface StartTaskSessionRequest {
	taskId: string;
	cwd: string;
	prompt: string;
	images?: RuntimeTaskImage[];
	resumeFromTrash?: boolean;
	providerId?: string | null;
	modelId?: string | null;
	mode?: RuntimeTaskSessionMode;
	apiKey?: string | null;
	baseUrl?: string | null;
	reasoningEffort?: RuntimeClineReasoningEffort | null;
}

export interface TaskSessionService {
	onSummary(listener: (summary: RuntimeTaskSessionSummary) => void): () => void;
	onMessage(listener: (taskId: string, message: TaskMessage) => void): () => void;
	startTaskSession(request: StartTaskSessionRequest): Promise<RuntimeTaskSessionSummary>;
	stopTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null>;
	abortTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null>;
	cancelTaskTurn(taskId: string): Promise<RuntimeTaskSessionSummary | null>;
	sendTaskSessionInput(
		taskId: string,
		text: string,
		mode?: RuntimeTaskSessionMode,
		images?: RuntimeTaskImage[],
	): Promise<RuntimeTaskSessionSummary | null>;
	reloadTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null>;
	rebindPersistedTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null>;
	getSummary(taskId: string): RuntimeTaskSessionSummary | null;
	listSummaries(): RuntimeTaskSessionSummary[];
	listMessages(taskId: string): TaskMessage[];
	loadTaskSessionMessages(taskId: string): Promise<TaskMessage[]>;
	applyTurnCheckpoint(taskId: string, checkpoint: RuntimeTaskTurnCheckpoint): RuntimeTaskSessionSummary | null;
	dispose(): Promise<void>;
}

function now(): number {
	return Date.now();
}

function createDefaultSummary(taskId: string): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "idle",
		mode: null,
		agentId: "cline",
		workspacePath: null,
		pid: null,
		startedAt: null,
		updatedAt: now(),
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		warningMessage: "Native Cline support has been removed from FS Kanban.",
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
	};
}

export class InMemoryTaskSessionService implements TaskSessionService {
	private readonly summaries = new Map<string, RuntimeTaskSessionSummary>();
	private readonly messages = new Map<string, TaskMessage[]>();
	private readonly summaryListeners = new Set<(summary: RuntimeTaskSessionSummary) => void>();
	private readonly messageListeners = new Set<(taskId: string, message: TaskMessage) => void>();

	onSummary(listener: (summary: RuntimeTaskSessionSummary) => void): () => void {
		this.summaryListeners.add(listener);
		return () => {
			this.summaryListeners.delete(listener);
		};
	}

	onMessage(listener: (taskId: string, message: TaskMessage) => void): () => void {
		this.messageListeners.add(listener);
		return () => {
			this.messageListeners.delete(listener);
		};
	}

	async startTaskSession(request: StartTaskSessionRequest): Promise<RuntimeTaskSessionSummary> {
		const summary: RuntimeTaskSessionSummary = {
			...createDefaultSummary(request.taskId),
			state: "failed",
			mode: request.mode ?? "act",
			workspacePath: request.cwd,
			startedAt: now(),
			lastOutputAt: now(),
			reviewReason: "error",
			updatedAt: now(),
		};
		this.summaries.set(request.taskId, summary);
		this.emitSummary(summary);
		return summary;
	}

	async stopTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null> {
		return this.getSummary(taskId);
	}

	async abortTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null> {
		return this.getSummary(taskId);
	}

	async cancelTaskTurn(taskId: string): Promise<RuntimeTaskSessionSummary | null> {
		return this.getSummary(taskId);
	}

	async sendTaskSessionInput(
		taskId: string,
		_text: string,
		_mode?: RuntimeTaskSessionMode,
		_images?: RuntimeTaskImage[],
	): Promise<RuntimeTaskSessionSummary | null> {
		return this.getSummary(taskId);
	}

	async reloadTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null> {
		return this.getSummary(taskId);
	}

	async rebindPersistedTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null> {
		return this.getSummary(taskId);
	}

	getSummary(taskId: string): RuntimeTaskSessionSummary | null {
		return this.summaries.get(taskId) ?? null;
	}

	listSummaries(): RuntimeTaskSessionSummary[] {
		return Array.from(this.summaries.values());
	}

	listMessages(taskId: string): TaskMessage[] {
		return this.messages.get(taskId) ?? [];
	}

	async loadTaskSessionMessages(taskId: string): Promise<TaskMessage[]> {
		return this.listMessages(taskId);
	}

	applyTurnCheckpoint(taskId: string, checkpoint: RuntimeTaskTurnCheckpoint): RuntimeTaskSessionSummary | null {
		const summary = this.summaries.get(taskId);
		if (!summary) {
			return null;
		}
		const nextSummary: RuntimeTaskSessionSummary = {
			...summary,
			previousTurnCheckpoint: summary.latestTurnCheckpoint ?? null,
			latestTurnCheckpoint: checkpoint,
			updatedAt: now(),
		};
		this.summaries.set(taskId, nextSummary);
		this.emitSummary(nextSummary);
		return nextSummary;
	}

	async dispose(): Promise<void> {
		this.summaries.clear();
		this.messages.clear();
	}

	private emitSummary(summary: RuntimeTaskSessionSummary): void {
		for (const listener of this.summaryListeners) {
			listener(summary);
		}
	}
}

export function createInMemoryTaskSessionService(): TaskSessionService {
	return new InMemoryTaskSessionService();
}

export type ClineTaskMessage = TaskMessage;
export interface ClineTaskSessionService extends TaskSessionService {}
export type StartClineTaskSessionRequest = StartTaskSessionRequest;
export { InMemoryTaskSessionService as InMemoryClineTaskSessionService };
export { createInMemoryTaskSessionService as createInMemoryClineTaskSessionService };
