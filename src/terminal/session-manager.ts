// PTY-backed runtime for task sessions and the workspace shell terminal.
// It owns process lifecycle, terminal protocol filtering, and summary updates
// for command-driven agents such as Claude Code, Codex, Gemini, and shell sessions.
import type {
	RuntimeAgentApprovalMode,
	RuntimeApprovalRequest,
	RuntimeTaskAttachment,
	RuntimeTaskHookActivity,
	RuntimeTaskImage,
	RuntimeTaskSessionReviewReason,
	RuntimeTaskSessionState,
	RuntimeTaskSessionSummary,
	RuntimeTaskTurnCheckpoint,
} from "../core/api-contract.js";
import {
	APPROVE_KEYSTROKES,
	buildHookActivityFingerprint,
	evaluateSupervisedApproval,
	isPermissionPromptActivity,
} from "./agent-approval-policy.js";
import {
	type AgentAdapterLaunchInput,
	type AgentOutputTransitionDetector,
	type AgentOutputTransitionInspectionPredicate,
	prepareAgentLaunch,
} from "./agent-session-adapters.js";
import {
	hasClaudeWorkspaceTrustPrompt,
	shouldAutoConfirmClaudeWorkspaceTrust,
	stopWorkspaceTrustTimers,
	WORKSPACE_TRUST_CONFIRM_DELAY_MS,
} from "./claude-workspace-trust.js";
import { hasCodexWorkspaceTrustPrompt, shouldAutoConfirmCodexWorkspaceTrust } from "./codex-workspace-trust.js";
import { OutputJournal } from "./output-journal.js";
import { MAX_HISTORY_BYTES, PtySession } from "./pty-session.js";
import { reduceSessionTransition, type SessionTransitionEvent } from "./session-state-machine.js";
import type { SupervisorApprovalQueue } from "./supervisor-approval-queue.js";
import {
	createTerminalProtocolFilterState,
	disableOsc11BackgroundQueryIntercept,
	filterTerminalProtocolOutput,
	type TerminalProtocolFilterState,
} from "./terminal-protocol-filter.js";
import type { TerminalSessionListener, TerminalSessionService } from "./terminal-session-service.js";

const MAX_WORKSPACE_TRUST_BUFFER_CHARS = 16_384;
const AUTO_RESTART_WINDOW_MS = 5_000;
const MAX_AUTO_RESTARTS_PER_WINDOW = 3;

// When KANBAN_DISABLE_AUTO_RESTART=1 is set, fs-kanban will NOT auto-respawn an
// agent terminal after its process exits. This is the right default for
// headless / pm2-managed deployments where an external SIGKILL or a real
// process crash should not silently relaunch the agent (which can burn tokens
// and obscure the failure). Interactive single-user installs leave it unset and
// keep the existing self-healing behavior.
const AUTO_RESTART_DISABLED = (() => {
	const raw = process.env.KANBAN_DISABLE_AUTO_RESTART?.trim().toLowerCase();
	return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
})();
const REPLAY_HISTORY_FLUSH_MS = 1_000;
const SUPERVISED_APPROVAL_DELAY_MS = 300;
// OpenCode can query OSC 11 before the browser terminal is attached and ready to answer.
// We intercept that startup probe during history replay and early PTY output, synthesize a
// background-color reply, then disable the filter once a live terminal listener has attached.
const OSC_BACKGROUND_QUERY_REPLY = "\u001b]11;rgb:1717/1717/2121\u001b\\";

type RestartableSessionRequest =
	| { kind: "task"; request: StartTaskSessionRequest }
	| { kind: "shell"; request: StartShellSessionRequest };

interface ActiveProcessState {
	session: PtySession;
	workspaceTrustBuffer: string | null;
	cols: number;
	rows: number;
	terminalProtocolFilter: TerminalProtocolFilterState;
	onSessionCleanup: (() => Promise<void>) | null;
	detectOutputTransition: AgentOutputTransitionDetector | null;
	shouldInspectOutputForTransition: AgentOutputTransitionInspectionPredicate | null;
	awaitingCodexPromptAfterEnter: boolean;
	approvalMode: RuntimeAgentApprovalMode;
	autoConfirmedWorkspaceTrust: boolean;
	workspaceTrustConfirmTimer: NodeJS.Timeout | null;
	supervisedApprovalTimer: NodeJS.Timeout | null;
	lastSupervisedApprovalFingerprint: string | null;
}

interface SessionEntry {
	summary: RuntimeTaskSessionSummary;
	active: ActiveProcessState | null;
	workspaceId: string | null;
	replayOutputHistory: Buffer[];
	listenerIdCounter: number;
	listeners: Map<number, TerminalSessionListener>;
	restartRequest: RestartableSessionRequest | null;
	suppressAutoRestartOnExit: boolean;
	autoRestartTimestamps: number[];
	pendingAutoRestart: Promise<void> | null;
}

export interface StartTaskSessionRequest {
	taskId: string;
	agentId: AgentAdapterLaunchInput["agentId"];
	binary: string;
	args: string[];
	approvalMode?: RuntimeAgentApprovalMode;
	autonomousModeEnabled?: boolean;
	cwd: string;
	prompt: string;
	attachments?: RuntimeTaskAttachment[];
	images?: RuntimeTaskImage[];
	startInPlanMode?: boolean;
	resumeFromTrash?: boolean;
	cols?: number;
	rows?: number;
	env?: Record<string, string | undefined>;
	workspaceId?: string;
}

export interface StartShellSessionRequest {
	taskId: string;
	cwd: string;
	cols?: number;
	rows?: number;
	binary: string;
	args?: string[];
	env?: Record<string, string | undefined>;
}

export interface TerminalSessionManagerOptions {
	workspaceJournalDir?: string;
	approvalQueue?: SupervisorApprovalQueue;
}

function now(): number {
	return Date.now();
}

function createDefaultSummary(taskId: string): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "idle",
		agentId: null,
		workspacePath: null,
		pid: null,
		startedAt: null,
		updatedAt: now(),
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		warningMessage: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
	};
}

function cloneSummary(summary: RuntimeTaskSessionSummary): RuntimeTaskSessionSummary {
	return {
		...summary,
	};
}

function normalizeStaleSessionSummary(summary: RuntimeTaskSessionSummary): RuntimeTaskSessionSummary {
	if (!isActiveState(summary.state)) {
		return cloneSummary(summary);
	}
	return {
		...summary,
		state: "interrupted",
		reviewReason: "interrupted",
		pid: null,
		updatedAt: now(),
	};
}

function trimReplayOutputHistory(history: Buffer[]): Buffer[] {
	let remainingBytes = MAX_HISTORY_BYTES;
	const trimmed: Buffer[] = [];
	for (let index = history.length - 1; index >= 0 && remainingBytes > 0; index -= 1) {
		const chunk = history[index];
		if (!chunk) {
			continue;
		}
		if (chunk.byteLength <= remainingBytes) {
			trimmed.unshift(chunk);
			remainingBytes -= chunk.byteLength;
			continue;
		}
		trimmed.unshift(Buffer.from(chunk.subarray(chunk.byteLength - remainingBytes)));
		remainingBytes = 0;
	}
	return trimmed;
}

function updateSummary(entry: SessionEntry, patch: Partial<RuntimeTaskSessionSummary>): RuntimeTaskSessionSummary {
	entry.summary = {
		...entry.summary,
		...patch,
		updatedAt: now(),
	};
	return entry.summary;
}

function isActiveState(state: RuntimeTaskSessionState): boolean {
	return state === "running" || state === "awaiting_review";
}

function cloneStartTaskSessionRequest(request: StartTaskSessionRequest): StartTaskSessionRequest {
	return {
		...request,
		args: [...request.args],
		attachments: request.attachments ? request.attachments.map((attachment) => ({ ...attachment })) : undefined,
		images: request.images ? request.images.map((image) => ({ ...image })) : undefined,
		env: request.env ? { ...request.env } : undefined,
	};
}

function cloneStartShellSessionRequest(request: StartShellSessionRequest): StartShellSessionRequest {
	return {
		...request,
		args: request.args ? [...request.args] : undefined,
		env: request.env ? { ...request.env } : undefined,
	};
}

function formatSpawnFailure(binary: string, error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const normalized = message.toLowerCase();
	if (normalized.includes("posix_spawnp failed") || normalized.includes("enoent")) {
		return `Failed to launch "${binary}". Command not found. Install a supported agent CLI and select it in Settings.`;
	}
	return `Failed to launch "${binary}": ${message}`;
}

function formatShellSpawnFailure(binary: string, error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const normalized = message.toLowerCase();
	if (normalized.includes("posix_spawnp failed") || normalized.includes("enoent")) {
		return `Failed to launch "${binary}". Command not found on this system.`;
	}
	return `Failed to launch "${binary}": ${message}`;
}

function buildTerminalEnvironment(
	...sources: Array<Record<string, string | undefined> | undefined>
): Record<string, string | undefined> {
	return {
		...process.env,
		...Object.assign({}, ...sources),
		COLORTERM: "truecolor",
		TERM: "xterm-256color",
		TERM_PROGRAM: "fs-kanban",
	};
}

function stopPendingSupervisedApproval(active: ActiveProcessState, resetFingerprint = true): void {
	if (active.supervisedApprovalTimer) {
		clearTimeout(active.supervisedApprovalTimer);
		active.supervisedApprovalTimer = null;
	}
	if (resetFingerprint) {
		active.lastSupervisedApprovalFingerprint = null;
	}
}

export class TerminalSessionManager implements TerminalSessionService {
	private readonly entries = new Map<string, SessionEntry>();
	private readonly summaryListeners = new Set<(summary: RuntimeTaskSessionSummary) => void>();
	private readonly replayHistoryListeners = new Set<(taskId: string, history: readonly Buffer[]) => void>();
	private readonly replayHistoryFlushTimers = new Map<string, NodeJS.Timeout>();
	private readonly workspaceJournalDir?: string;
	private readonly journalsByTaskId = new Map<string, OutputJournal>();
	private readonly approvalQueue?: SupervisorApprovalQueue;

	constructor(options: TerminalSessionManagerOptions = {}) {
		this.workspaceJournalDir = options.workspaceJournalDir;
		this.approvalQueue = options.approvalQueue;
	}

	onSummary(listener: (summary: RuntimeTaskSessionSummary) => void): () => void {
		this.summaryListeners.add(listener);
		return () => {
			this.summaryListeners.delete(listener);
		};
	}

	onReplayHistory(listener: (taskId: string, history: readonly Buffer[]) => void): () => void {
		this.replayHistoryListeners.add(listener);
		return () => {
			this.replayHistoryListeners.delete(listener);
		};
	}

	hydrateFromRecord(
		record: Record<string, RuntimeTaskSessionSummary>,
		replayHistoryByTaskId: Record<string, readonly Buffer[]> = {},
		workspaceId: string | null = null,
	): void {
		for (const [taskId, summary] of Object.entries(record)) {
			const replayOutputHistory = (replayHistoryByTaskId[taskId] ?? []).map((chunk) => Buffer.from(chunk));
			this.entries.set(taskId, {
				summary: normalizeStaleSessionSummary(summary),
				active: null,
				workspaceId,
				replayOutputHistory: trimReplayOutputHistory(replayOutputHistory),
				listenerIdCounter: 1,
				listeners: new Map(),
				restartRequest: null,
				suppressAutoRestartOnExit: false,
				autoRestartTimestamps: [],
				pendingAutoRestart: null,
			});
			// After a runtime restart, no PTY is active for any hydrated task. Any
			// pending approval replayed from the audit log against a now-dead session
			// must be cancelled so the Supervisor panel does not show ghost requests.
			this.approvalQueue?.cancelPendingForTask(workspaceId, taskId);
		}
	}

	getSummary(taskId: string): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		return entry ? cloneSummary(entry.summary) : null;
	}

	getWorkspaceId(taskId: string): string | null {
		return this.entries.get(taskId)?.workspaceId ?? null;
	}

	listSummaries(): RuntimeTaskSessionSummary[] {
		return Array.from(this.entries.values()).map((entry) => cloneSummary(entry.summary));
	}

	listReplayHistories(): Record<string, Buffer[]> {
		const histories: Record<string, Buffer[]> = {};
		for (const [taskId, entry] of this.entries) {
			const history = this.getReplayHistorySnapshot(entry);
			if (history.length === 0) {
				continue;
			}
			histories[taskId] = history;
		}
		return histories;
	}

	attach(taskId: string, listener: TerminalSessionListener): (() => void) | null {
		const entry = this.ensureEntry(taskId);

		listener.onState?.(cloneSummary(entry.summary));
		const replayFilterState = createTerminalProtocolFilterState({
			interceptOsc11BackgroundQueries: true,
			suppressDeviceAttributeQueries: entry.active?.terminalProtocolFilter.suppressDeviceAttributeQueries ?? false,
		});
		for (const chunk of entry.active?.session.getOutputHistory() ?? entry.replayOutputHistory) {
			const filteredChunk = filterTerminalProtocolOutput(replayFilterState, chunk, {
				onOsc11BackgroundQuery: () => entry.active?.session.write(OSC_BACKGROUND_QUERY_REPLY),
			});
			if (filteredChunk.byteLength > 0) {
				listener.onOutput?.(filteredChunk);
			}
		}
		if (entry.active && listener.onOutput) {
			disableOsc11BackgroundQueryIntercept(entry.active.terminalProtocolFilter);
		}

		const listenerId = entry.listenerIdCounter;
		entry.listenerIdCounter += 1;
		entry.listeners.set(listenerId, listener);

		return () => {
			entry.listeners.delete(listenerId);
		};
	}

	async startTaskSession(request: StartTaskSessionRequest): Promise<RuntimeTaskSessionSummary> {
		const entry = this.ensureEntry(request.taskId);
		if (request.workspaceId !== undefined) {
			entry.workspaceId = request.workspaceId;
		}
		entry.restartRequest = {
			kind: "task",
			request: cloneStartTaskSessionRequest(request),
		};
		if (entry.active && isActiveState(entry.summary.state)) {
			return cloneSummary(entry.summary);
		}

		if (entry.active) {
			stopPendingSupervisedApproval(entry.active);
			stopWorkspaceTrustTimers(entry.active);
			entry.active.session.stop();
			entry.active = null;
		}
		entry.replayOutputHistory = [];
		this.flushReplayHistory(request.taskId);

		const cols = Number.isFinite(request.cols) && (request.cols ?? 0) > 0 ? Math.floor(request.cols ?? 0) : 120;
		const rows = Number.isFinite(request.rows) && (request.rows ?? 0) > 0 ? Math.floor(request.rows ?? 0) : 40;

		const launch = await prepareAgentLaunch({
			taskId: request.taskId,
			agentId: request.agentId,
			binary: request.binary,
			args: request.args,
			approvalMode: request.approvalMode,
			autonomousModeEnabled: request.autonomousModeEnabled,
			cwd: request.cwd,
			prompt: request.prompt,
			attachments: request.attachments,
			images: request.images,
			startInPlanMode: request.startInPlanMode,
			resumeFromTrash: request.resumeFromTrash,
			env: request.env,
			workspaceId: request.workspaceId,
		});

		const env = buildTerminalEnvironment(request.env, launch.env);

		// Adapters can wrap the configured agent binary when they need extra runtime wiring
		// (for example, Codex uses a wrapper script to watch session logs for hook transitions).
		const commandBinary = launch.binary ?? request.binary;
		const commandArgs = [...launch.args];
		const hasCodexLaunchSignature = [commandBinary, ...commandArgs].some((part) =>
			part.toLowerCase().includes("codex"),
		);
		let session: PtySession;
		const journal = this.createOutputJournal(request.taskId);
		try {
			session = PtySession.spawn({
				binary: commandBinary,
				args: commandArgs,
				cwd: request.cwd,
				env,
				cols,
				rows,
				...(journal ? { outputSink: journal.append.bind(journal) } : {}),
				onData: (chunk) => {
					if (!entry.active) {
						return;
					}

					const filteredChunk = filterTerminalProtocolOutput(entry.active.terminalProtocolFilter, chunk, {
						onOsc11BackgroundQuery: () => entry.active?.session.write(OSC_BACKGROUND_QUERY_REPLY),
					});
					if (filteredChunk.byteLength === 0) {
						return;
					}

					const needsDecodedOutput =
						entry.active.workspaceTrustBuffer !== null ||
						(entry.active.detectOutputTransition !== null &&
							(entry.active.shouldInspectOutputForTransition?.(entry.summary) ?? true));
					const data = needsDecodedOutput ? filteredChunk.toString("utf8") : "";

					if (entry.active.workspaceTrustBuffer !== null) {
						entry.active.workspaceTrustBuffer += data;
						if (entry.active.workspaceTrustBuffer.length > MAX_WORKSPACE_TRUST_BUFFER_CHARS) {
							entry.active.workspaceTrustBuffer = entry.active.workspaceTrustBuffer.slice(
								-MAX_WORKSPACE_TRUST_BUFFER_CHARS,
							);
						}
						if (!entry.active.autoConfirmedWorkspaceTrust && entry.active.workspaceTrustConfirmTimer === null) {
							const hasClaudePrompt = hasClaudeWorkspaceTrustPrompt(entry.active.workspaceTrustBuffer);
							const hasCodexPrompt = hasCodexWorkspaceTrustPrompt(entry.active.workspaceTrustBuffer);
							if (hasClaudePrompt || hasCodexPrompt) {
								entry.active.autoConfirmedWorkspaceTrust = true;
								const trustConfirmDelayMs = WORKSPACE_TRUST_CONFIRM_DELAY_MS;
								entry.active.workspaceTrustConfirmTimer = setTimeout(() => {
									const activeEntry = this.entries.get(request.taskId)?.active;
									if (!activeEntry || !activeEntry.autoConfirmedWorkspaceTrust) {
										return;
									}
									activeEntry.session.write("\r");
									activeEntry.workspaceTrustConfirmTimer = null;
								}, trustConfirmDelayMs);
							}
						}
					}
					updateSummary(entry, { lastOutputAt: now() });

					const adapterEvent = entry.active.detectOutputTransition?.(data, entry.summary) ?? null;
					if (adapterEvent) {
						const requiresEnterForCodex =
							adapterEvent.type === "agent.prompt-ready" &&
							entry.summary.agentId === "codex" &&
							!entry.active.awaitingCodexPromptAfterEnter;
						if (!requiresEnterForCodex) {
							const summary = this.applySessionEvent(entry, adapterEvent);
							if (adapterEvent.type === "agent.prompt-ready" && entry.summary.agentId === "codex") {
								entry.active.awaitingCodexPromptAfterEnter = false;
							}
							for (const taskListener of entry.listeners.values()) {
								taskListener.onState?.(cloneSummary(summary));
							}
							this.emitSummary(summary);
						}
					}

					for (const taskListener of entry.listeners.values()) {
						taskListener.onOutput?.(filteredChunk);
					}
					this.scheduleReplayHistoryFlush(request.taskId);
				},
				onExit: async (event) => {
					try {
						const currentEntry = this.entries.get(request.taskId);
						if (!currentEntry) {
							return;
						}
						const currentActive = currentEntry.active;
						if (!currentActive) {
							return;
						}
						stopPendingSupervisedApproval(currentActive);
						stopWorkspaceTrustTimers(currentActive);
						this.approvalQueue?.cancelPendingForTask(currentEntry.workspaceId, request.taskId);

						const summary = this.applySessionEvent(currentEntry, {
							type: "process.exit",
							exitCode: event.exitCode,
							interrupted: currentActive.session.wasInterrupted(),
						});
						const shouldAutoRestart = this.shouldAutoRestart(currentEntry);

						for (const taskListener of currentEntry.listeners.values()) {
							taskListener.onState?.(cloneSummary(summary));
							taskListener.onExit?.(event.exitCode);
						}
						currentEntry.replayOutputHistory = currentActive.session
							.getOutputHistory()
							.map((chunk) => Buffer.from(chunk));
						currentEntry.active = null;
						this.flushReplayHistory(request.taskId);
						this.emitSummary(summary);
						if (shouldAutoRestart) {
							this.scheduleAutoRestart(currentEntry);
						}

						const cleanupFn = currentActive.onSessionCleanup;
						currentActive.onSessionCleanup = null;
						if (cleanupFn) {
							cleanupFn().catch(() => {
								// Best effort: cleanup failure is non-critical.
							});
						}
					} finally {
						await this.closeOutputJournal(request.taskId, journal);
					}
				},
			});
		} catch (error) {
			await this.closeOutputJournal(request.taskId, journal);
			if (launch.cleanup) {
				void launch.cleanup().catch(() => {
					// Best effort: cleanup failure is non-critical.
				});
			}
			const summary = updateSummary(entry, {
				state: "failed",
				agentId: request.agentId,
				workspacePath: request.cwd,
				pid: null,
				startedAt: null,
				lastOutputAt: null,
				reviewReason: "error",
				exitCode: null,
				lastHookAt: null,
				latestHookActivity: null,
				latestTurnCheckpoint: null,
				previousTurnCheckpoint: null,
			});
			this.emitSummary(summary);
			throw new Error(formatSpawnFailure(commandBinary, error));
		}

		const active: ActiveProcessState = {
			session,
			workspaceTrustBuffer:
				shouldAutoConfirmClaudeWorkspaceTrust(request.agentId, request.cwd) ||
				shouldAutoConfirmCodexWorkspaceTrust(request.agentId, request.cwd) ||
				hasCodexLaunchSignature
					? ""
					: null,
			cols,
			rows,
			terminalProtocolFilter: createTerminalProtocolFilterState({
				interceptOsc11BackgroundQueries: true,
				suppressDeviceAttributeQueries: false,
			}),
			onSessionCleanup: launch.cleanup ?? null,
			detectOutputTransition: launch.detectOutputTransition ?? null,
			shouldInspectOutputForTransition: launch.shouldInspectOutputForTransition ?? null,
			awaitingCodexPromptAfterEnter: false,
			approvalMode: request.approvalMode ?? (request.autonomousModeEnabled ? "full_auto" : "manual"),
			autoConfirmedWorkspaceTrust: false,
			workspaceTrustConfirmTimer: null,
			supervisedApprovalTimer: null,
			lastSupervisedApprovalFingerprint: null,
		};
		entry.active = active;

		const startedAt = now();
		updateSummary(entry, {
			state: request.resumeFromTrash ? "awaiting_review" : "running",
			agentId: request.agentId,
			workspacePath: request.cwd,
			pid: session.pid,
			startedAt,
			lastOutputAt: null,
			reviewReason: request.resumeFromTrash ? "attention" : null,
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
			warningMessage: null,
			latestTurnCheckpoint: null,
			previousTurnCheckpoint: null,
		});
		this.emitSummary(entry.summary);

		return cloneSummary(entry.summary);
	}

	async startShellSession(request: StartShellSessionRequest): Promise<RuntimeTaskSessionSummary> {
		const entry = this.ensureEntry(request.taskId);
		entry.restartRequest = {
			kind: "shell",
			request: cloneStartShellSessionRequest(request),
		};
		if (entry.active && entry.summary.state === "running") {
			return cloneSummary(entry.summary);
		}

		if (entry.active) {
			stopPendingSupervisedApproval(entry.active);
			stopWorkspaceTrustTimers(entry.active);
			entry.active.session.stop();
			entry.active = null;
		}
		entry.replayOutputHistory = [];
		this.flushReplayHistory(request.taskId);

		const cols = Number.isFinite(request.cols) && (request.cols ?? 0) > 0 ? Math.floor(request.cols ?? 0) : 120;
		const rows = Number.isFinite(request.rows) && (request.rows ?? 0) > 0 ? Math.floor(request.rows ?? 0) : 40;
		const env = buildTerminalEnvironment(request.env);

		let session: PtySession;
		const journal = this.createOutputJournal(request.taskId);
		try {
			session = PtySession.spawn({
				binary: request.binary,
				args: request.args ?? [],
				cwd: request.cwd,
				env,
				cols,
				rows,
				...(journal ? { outputSink: journal.append.bind(journal) } : {}),
				onData: (chunk) => {
					if (!entry.active) {
						return;
					}

					const filteredChunk = filterTerminalProtocolOutput(entry.active.terminalProtocolFilter, chunk, {
						onOsc11BackgroundQuery: () => entry.active?.session.write(OSC_BACKGROUND_QUERY_REPLY),
					});
					if (filteredChunk.byteLength === 0) {
						return;
					}

					if (entry.active.workspaceTrustBuffer !== null) {
						entry.active.workspaceTrustBuffer += filteredChunk.toString("utf8");
						if (entry.active.workspaceTrustBuffer.length > MAX_WORKSPACE_TRUST_BUFFER_CHARS) {
							entry.active.workspaceTrustBuffer = entry.active.workspaceTrustBuffer.slice(
								-MAX_WORKSPACE_TRUST_BUFFER_CHARS,
							);
						}
					}
					updateSummary(entry, { lastOutputAt: now() });

					for (const taskListener of entry.listeners.values()) {
						taskListener.onOutput?.(filteredChunk);
					}
					this.scheduleReplayHistoryFlush(request.taskId);
				},
				onExit: async (event) => {
					try {
						const currentEntry = this.entries.get(request.taskId);
						if (!currentEntry) {
							return;
						}
						const currentActive = currentEntry.active;
						if (!currentActive) {
							return;
						}
						stopPendingSupervisedApproval(currentActive);
						stopWorkspaceTrustTimers(currentActive);

						const summary = updateSummary(currentEntry, {
							state: currentActive.session.wasInterrupted() ? "interrupted" : "idle",
							reviewReason: currentActive.session.wasInterrupted() ? "interrupted" : null,
							exitCode: event.exitCode,
							pid: null,
						});

						for (const taskListener of currentEntry.listeners.values()) {
							taskListener.onState?.(cloneSummary(summary));
							taskListener.onExit?.(event.exitCode);
						}
						currentEntry.replayOutputHistory = currentActive.session
							.getOutputHistory()
							.map((chunk) => Buffer.from(chunk));
						currentEntry.active = null;
						this.flushReplayHistory(request.taskId);
						this.emitSummary(summary);
					} finally {
						await this.closeOutputJournal(request.taskId, journal);
					}
				},
			});
		} catch (error) {
			await this.closeOutputJournal(request.taskId, journal);
			const summary = updateSummary(entry, {
				state: "failed",
				agentId: null,
				workspacePath: request.cwd,
				pid: null,
				startedAt: null,
				lastOutputAt: null,
				reviewReason: "error",
				exitCode: null,
				lastHookAt: null,
				latestHookActivity: null,
				latestTurnCheckpoint: null,
				previousTurnCheckpoint: null,
			});
			this.emitSummary(summary);
			throw new Error(formatShellSpawnFailure(request.binary, error));
		}

		const active: ActiveProcessState = {
			session,
			workspaceTrustBuffer: null,
			cols,
			rows,
			terminalProtocolFilter: createTerminalProtocolFilterState({
				interceptOsc11BackgroundQueries: true,
			}),
			onSessionCleanup: null,
			detectOutputTransition: null,
			shouldInspectOutputForTransition: null,
			awaitingCodexPromptAfterEnter: false,
			approvalMode: "manual",
			autoConfirmedWorkspaceTrust: false,
			workspaceTrustConfirmTimer: null,
			supervisedApprovalTimer: null,
			lastSupervisedApprovalFingerprint: null,
		};
		entry.active = active;

		updateSummary(entry, {
			state: "running",
			agentId: null,
			workspacePath: request.cwd,
			pid: session.pid,
			startedAt: now(),
			lastOutputAt: null,
			reviewReason: null,
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
			warningMessage: null,
			latestTurnCheckpoint: null,
			previousTurnCheckpoint: null,
		});
		this.emitSummary(entry.summary);

		return cloneSummary(entry.summary);
	}

	recoverStaleSession(taskId: string): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}
		if (entry.active || !isActiveState(entry.summary.state)) {
			return cloneSummary(entry.summary);
		}

		entry.summary = normalizeStaleSessionSummary(entry.summary);
		const summary = cloneSummary(entry.summary);

		for (const listener of entry.listeners.values()) {
			listener.onState?.(cloneSummary(summary));
		}
		this.emitSummary(summary);
		return cloneSummary(summary);
	}

	writeInput(taskId: string, data: Buffer): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return null;
		}
		stopPendingSupervisedApproval(entry.active);
		// User is interacting directly with the terminal — any pending approval
		// queue entries for this task are now stale (the user is dismissing or
		// answering the prompt themselves). Cancel them so the Supervisor panel
		// does not retain a stale entry that could cause applyDecision to write
		// keystrokes into a different prompt later.
		this.approvalQueue?.cancelPendingForTask(entry.workspaceId, taskId);
		if (
			entry.summary.agentId === "codex" &&
			entry.summary.state === "awaiting_review" &&
			(entry.summary.reviewReason === "hook" ||
				entry.summary.reviewReason === "attention" ||
				entry.summary.reviewReason === "error") &&
			(data.includes(13) || data.includes(10))
		) {
			entry.active.awaitingCodexPromptAfterEnter = true;
		}
		entry.active.session.write(data);
		return cloneSummary(entry.summary);
	}

	resize(taskId: string, cols: number, rows: number, pixelWidth?: number, pixelHeight?: number): boolean {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return false;
		}
		const safeCols = Math.max(1, Math.floor(cols));
		const safeRows = Math.max(1, Math.floor(rows));
		const safePixelWidth = Number.isFinite(pixelWidth ?? Number.NaN) ? Math.floor(pixelWidth as number) : undefined;
		const safePixelHeight = Number.isFinite(pixelHeight ?? Number.NaN)
			? Math.floor(pixelHeight as number)
			: undefined;
		const normalizedPixelWidth = safePixelWidth !== undefined && safePixelWidth > 0 ? safePixelWidth : undefined;
		const normalizedPixelHeight = safePixelHeight !== undefined && safePixelHeight > 0 ? safePixelHeight : undefined;
		entry.active.session.resize(safeCols, safeRows, normalizedPixelWidth, normalizedPixelHeight);
		entry.active.cols = safeCols;
		entry.active.rows = safeRows;
		return true;
	}

	pauseOutput(taskId: string): boolean {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return false;
		}
		entry.active.session.pause();
		return true;
	}

	resumeOutput(taskId: string): boolean {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return false;
		}
		entry.active.session.resume();
		return true;
	}

	transitionToReview(taskId: string, reason: RuntimeTaskSessionReviewReason): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}
		if (reason !== "hook") {
			return cloneSummary(entry.summary);
		}
		const before = entry.summary;
		const summary = this.applySessionEvent(entry, { type: "hook.to_review" });
		if (summary !== before && entry.active) {
			for (const listener of entry.listeners.values()) {
				listener.onState?.(cloneSummary(summary));
			}
			this.emitSummary(summary);
		}
		return cloneSummary(summary);
	}

	maybeAutoApprovePendingPrompt(taskId: string): boolean {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return false;
		}
		if (entry.summary.state !== "awaiting_review" || !isPermissionPromptActivity(entry.summary.latestHookActivity)) {
			stopPendingSupervisedApproval(entry.active);
			return false;
		}

		const activity = entry.summary.latestHookActivity;
		if (!activity) {
			stopPendingSupervisedApproval(entry.active);
			return false;
		}

		// Surface pending requests to the Supervisor panel when we have both a queue and
		// the workspace context for the entry. Falls back to the legacy silent path
		// otherwise (preserves backward-compat with tests that construct entries
		// without workspaceId or queue).
		const request =
			this.approvalQueue && entry.workspaceId
				? this.approvalQueue.enqueue({
						taskId,
						workspaceId: entry.workspaceId,
						agentId: entry.summary.agentId,
						activity,
					})
				: null;

		if (entry.active.approvalMode !== "supervised") {
			stopPendingSupervisedApproval(entry.active);
			return false;
		}

		const decision = evaluateSupervisedApproval(activity);
		if (!decision.shouldAutoApprove) {
			stopPendingSupervisedApproval(entry.active);
			return false;
		}

		const fingerprint = buildHookActivityFingerprint(activity);
		if (
			entry.active.supervisedApprovalTimer !== null &&
			entry.active.lastSupervisedApprovalFingerprint === fingerprint
		) {
			return true;
		}

		stopPendingSupervisedApproval(entry.active, false);
		entry.active.lastSupervisedApprovalFingerprint = fingerprint;
		const timer = setTimeout(() => {
			const currentEntry = this.entries.get(taskId);
			const currentActive = currentEntry?.active;
			const currentSummary = currentEntry?.summary;
			if (
				!currentActive ||
				!currentSummary ||
				currentActive.approvalMode !== "supervised" ||
				currentSummary.state !== "awaiting_review" ||
				currentActive.lastSupervisedApprovalFingerprint !== fingerprint
			) {
				return;
			}
			if (request && this.approvalQueue) {
				this.approvalQueue.decide(request.id, "auto_approved", "policy");
			}
			currentActive.session.write(APPROVE_KEYSTROKES[currentSummary.agentId ?? "codex"]?.approve ?? "\r");
			currentActive.supervisedApprovalTimer = null;
		}, SUPERVISED_APPROVAL_DELAY_MS);
		timer.unref?.();
		entry.active.supervisedApprovalTimer = timer;
		return true;
	}

	/**
	 * Apply a user decision to an approval request. Called from the tRPC mutation.
	 * Looks up the request via the queue, validates it belongs to a task with an
	 * active session, decides the queue, and writes the corresponding keystroke
	 * to the PTY. Returns the updated request, or null if the request cannot be
	 * acted upon (not pending, no active session, etc.).
	 */
	applyDecision(requestId: string, decision: "approved" | "denied"): RuntimeApprovalRequest | null {
		if (!this.approvalQueue) return null;
		const request = this.approvalQueue.get(requestId);
		if (!request) return null;
		if (request.status !== "pending") return null;
		const entry = this.entries.get(request.taskId);
		if (!entry?.active) return null;
		// Defense in depth: do NOT write keystrokes into a session that has moved
		// past the prompt. The cancel-on-transition logic above should already
		// remove these from the queue, but a stale tRPC mutation could race.
		if (entry.summary.state !== "awaiting_review") return null;
		if (!isPermissionPromptActivity(entry.summary.latestHookActivity)) return null;
		const liveFingerprint = buildHookActivityFingerprint(entry.summary.latestHookActivity);
		if (liveFingerprint !== request.fingerprint) return null;
		const status = decision === "approved" ? "user_approved" : "user_denied";
		const updated = this.approvalQueue.decide(requestId, status, "user");
		if (!updated) return null;
		const keystrokes = APPROVE_KEYSTROKES[entry.summary.agentId ?? "codex"] ?? APPROVE_KEYSTROKES.codex;
		const key = decision === "approved" ? keystrokes.approve : keystrokes.deny;
		stopPendingSupervisedApproval(entry.active, false);
		try {
			entry.active.session.write(key);
		} catch {
			// PTY write errors are surfaced via the session's existing error handling.
		}
		return updated;
	}

	applyHookActivity(taskId: string, activity: Partial<RuntimeTaskHookActivity>): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}

		const hasActivityUpdate =
			typeof activity.activityText === "string" ||
			typeof activity.toolName === "string" ||
			typeof activity.toolInputSummary === "string" ||
			typeof activity.finalMessage === "string" ||
			typeof activity.hookEventName === "string" ||
			typeof activity.notificationType === "string" ||
			typeof activity.source === "string";
		if (!hasActivityUpdate) {
			return cloneSummary(entry.summary);
		}

		const previous = entry.summary.latestHookActivity;
		const next: RuntimeTaskHookActivity = {
			activityText:
				typeof activity.activityText === "string" ? activity.activityText : (previous?.activityText ?? null),
			toolName: typeof activity.toolName === "string" ? activity.toolName : (previous?.toolName ?? null),
			toolInputSummary:
				typeof activity.toolInputSummary === "string"
					? activity.toolInputSummary
					: (previous?.toolInputSummary ?? null),
			finalMessage:
				typeof activity.finalMessage === "string" ? activity.finalMessage : (previous?.finalMessage ?? null),
			hookEventName:
				typeof activity.hookEventName === "string" ? activity.hookEventName : (previous?.hookEventName ?? null),
			notificationType:
				typeof activity.notificationType === "string"
					? activity.notificationType
					: (previous?.notificationType ?? null),
			source: typeof activity.source === "string" ? activity.source : (previous?.source ?? null),
		};

		const didChange =
			next.activityText !== (previous?.activityText ?? null) ||
			next.toolName !== (previous?.toolName ?? null) ||
			next.toolInputSummary !== (previous?.toolInputSummary ?? null) ||
			next.finalMessage !== (previous?.finalMessage ?? null) ||
			next.hookEventName !== (previous?.hookEventName ?? null) ||
			next.notificationType !== (previous?.notificationType ?? null) ||
			next.source !== (previous?.source ?? null);
		if (!didChange) {
			return cloneSummary(entry.summary);
		}

		const summary = updateSummary(entry, {
			lastHookAt: now(),
			latestHookActivity: next,
		});
		if (entry.active) {
			for (const listener of entry.listeners.values()) {
				listener.onState?.(cloneSummary(summary));
			}
		}
		this.emitSummary(summary);
		return cloneSummary(summary);
	}

	transitionToRunning(taskId: string): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}
		const before = entry.summary;
		const summary = this.applySessionEvent(entry, { type: "hook.to_in_progress" });
		if (summary !== before && entry.active) {
			for (const listener of entry.listeners.values()) {
				listener.onState?.(cloneSummary(summary));
			}
			this.emitSummary(summary);
		}
		return cloneSummary(summary);
	}

	applyTurnCheckpoint(taskId: string, checkpoint: RuntimeTaskTurnCheckpoint): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}

		const latestCheckpoint = entry.summary.latestTurnCheckpoint ?? null;
		if (latestCheckpoint?.ref === checkpoint.ref && latestCheckpoint.commit === checkpoint.commit) {
			return cloneSummary(entry.summary);
		}

		const summary = updateSummary(entry, {
			previousTurnCheckpoint: latestCheckpoint,
			latestTurnCheckpoint: checkpoint,
		});
		if (entry.active) {
			for (const listener of entry.listeners.values()) {
				listener.onState?.(cloneSummary(summary));
			}
		}
		this.emitSummary(summary);
		return cloneSummary(summary);
	}

	stopTaskSession(taskId: string): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return entry ? cloneSummary(entry.summary) : null;
		}
		entry.suppressAutoRestartOnExit = true;
		const cleanupFn = entry.active.onSessionCleanup;
		entry.active.onSessionCleanup = null;
		stopPendingSupervisedApproval(entry.active);
		stopWorkspaceTrustTimers(entry.active);
		this.approvalQueue?.cancelPendingForTask(entry.workspaceId, taskId);
		entry.active.session.stop();
		if (cleanupFn) {
			cleanupFn().catch(() => {
				// Best effort: cleanup failure is non-critical.
			});
		}
		return cloneSummary(entry.summary);
	}

	markInterruptedAndStopAll(): RuntimeTaskSessionSummary[] {
		const activeEntries = Array.from(this.entries.values()).filter((entry) => entry.active != null);
		for (const entry of activeEntries) {
			if (!entry.active) {
				continue;
			}
			stopPendingSupervisedApproval(entry.active);
			stopWorkspaceTrustTimers(entry.active);
			this.approvalQueue?.cancelPendingForTask(entry.workspaceId, entry.summary.taskId);
			entry.active.session.stop({ interrupted: true });
		}
		return activeEntries.map((entry) => cloneSummary(entry.summary));
	}

	private applySessionEvent(entry: SessionEntry, event: SessionTransitionEvent): RuntimeTaskSessionSummary {
		const transition = reduceSessionTransition(entry.summary, event);
		if (!transition.changed) {
			return entry.summary;
		}
		if (transition.clearAttentionBuffer && entry.active) {
			if (entry.active.workspaceTrustBuffer !== null) {
				entry.active.workspaceTrustBuffer = "";
			}
		}
		if (entry.active && transition.changed) {
			if (transition.patch.state === "awaiting_review") {
				entry.active.awaitingCodexPromptAfterEnter = false;
			}
			if (transition.patch.state === "awaiting_review" || transition.patch.state === "running") {
				stopPendingSupervisedApproval(entry.active);
			}
		}
		// Transition out of awaiting_review (back to running, or process exit) means
		// any prior pending approval is no longer actionable — cancel queue entries
		// so applyDecision can't fire keystrokes into a different prompt.
		const previousState = entry.summary.state;
		const nextState = transition.patch.state ?? previousState;
		if (previousState === "awaiting_review" && nextState !== "awaiting_review") {
			this.approvalQueue?.cancelPendingForTask(entry.workspaceId, entry.summary.taskId);
		}
		return updateSummary(entry, transition.patch);
	}

	private ensureEntry(taskId: string): SessionEntry {
		const existing = this.entries.get(taskId);
		if (existing) {
			return existing;
		}
		const created: SessionEntry = {
			summary: createDefaultSummary(taskId),
			active: null,
			workspaceId: null,
			replayOutputHistory: [],
			listenerIdCounter: 1,
			listeners: new Map(),
			restartRequest: null,
			suppressAutoRestartOnExit: false,
			autoRestartTimestamps: [],
			pendingAutoRestart: null,
		};
		this.entries.set(taskId, created);
		return created;
	}

	private getReplayHistorySnapshot(entry: SessionEntry): Buffer[] {
		const source = entry.active?.session.getOutputHistory() ?? entry.replayOutputHistory;
		return source.map((chunk) => Buffer.from(chunk));
	}

	private createOutputJournal(taskId: string): OutputJournal | null {
		if (!this.workspaceJournalDir) {
			return null;
		}
		const journal = new OutputJournal({ dir: this.workspaceJournalDir, taskId });
		this.journalsByTaskId.set(taskId, journal);
		return journal;
	}

	private async closeOutputJournal(taskId: string, journal: OutputJournal | null): Promise<void> {
		if (!journal) {
			return;
		}
		await journal.close().catch(() => {});
		if (this.journalsByTaskId.get(taskId) === journal) {
			this.journalsByTaskId.delete(taskId);
		}
	}

	private scheduleReplayHistoryFlush(taskId: string): void {
		if (this.replayHistoryFlushTimers.has(taskId)) {
			return;
		}
		const timer = setTimeout(() => {
			this.replayHistoryFlushTimers.delete(taskId);
			this.flushReplayHistory(taskId);
		}, REPLAY_HISTORY_FLUSH_MS);
		timer.unref();
		this.replayHistoryFlushTimers.set(taskId, timer);
	}

	private flushReplayHistory(taskId: string): void {
		const timer = this.replayHistoryFlushTimers.get(taskId);
		if (timer) {
			clearTimeout(timer);
			this.replayHistoryFlushTimers.delete(taskId);
		}
		const entry = this.entries.get(taskId);
		if (!entry) {
			return;
		}
		const history = this.getReplayHistorySnapshot(entry);
		for (const listener of this.replayHistoryListeners) {
			listener(taskId, history);
		}
	}

	private shouldAutoRestart(entry: SessionEntry): boolean {
		// Honor explicit suppression (e.g. UI "Stop session") even when auto-restart
		// is globally disabled — we still want to drop the timestamp on exit so the
		// next manual start has a clean slate.
		const wasSuppressed = entry.suppressAutoRestartOnExit;
		entry.suppressAutoRestartOnExit = false;
		if (wasSuppressed) {
			return false;
		}
		if (AUTO_RESTART_DISABLED) {
			return false;
		}
		if (entry.listeners.size === 0 || entry.restartRequest?.kind !== "task") {
			return false;
		}
		const currentTime = now();
		entry.autoRestartTimestamps = entry.autoRestartTimestamps.filter(
			(timestamp) => currentTime - timestamp < AUTO_RESTART_WINDOW_MS,
		);
		if (entry.autoRestartTimestamps.length >= MAX_AUTO_RESTARTS_PER_WINDOW) {
			return false;
		}
		entry.autoRestartTimestamps.push(currentTime);
		return true;
	}

	private scheduleAutoRestart(entry: SessionEntry): void {
		if (entry.pendingAutoRestart) {
			return;
		}
		const restartRequest = entry.restartRequest;
		if (!restartRequest || restartRequest.kind !== "task") {
			return;
		}
		let pendingAutoRestart: Promise<void> | null = null;
		pendingAutoRestart = (async () => {
			try {
				await this.startTaskSession(cloneStartTaskSessionRequest(restartRequest.request));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const summary = updateSummary(entry, {
					warningMessage: message,
				});
				const output = Buffer.from(`\r\n[kanban] ${message}\r\n`, "utf8");
				for (const listener of entry.listeners.values()) {
					listener.onOutput?.(output);
					listener.onState?.(cloneSummary(summary));
				}
				this.emitSummary(summary);
			} finally {
				if (entry.pendingAutoRestart === pendingAutoRestart) {
					entry.pendingAutoRestart = null;
				}
			}
		})();
		entry.pendingAutoRestart = pendingAutoRestart;
	}

	private emitSummary(summary: RuntimeTaskSessionSummary): void {
		const snapshot = cloneSummary(summary);
		for (const listener of this.summaryListeners) {
			listener(snapshot);
		}
	}
}
