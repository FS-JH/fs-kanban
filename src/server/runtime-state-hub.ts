// Streams live runtime state to browser clients over websocket.
// It listens to terminal and native agent updates, normalizes them into the
// shared API contract, and fans out workspace-scoped snapshots and deltas.
import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type {
	RuntimeStateStreamAggregateBoardUpdatedMessage,
	RuntimeStateStreamAggregateSnapshotMessage,
	RuntimeStateStreamErrorMessage,
	RuntimeStateStreamMessage,
	RuntimeStateStreamProjectsMessage,
	RuntimeStateStreamSnapshotMessage,
	RuntimeStateStreamTaskReadyForReviewMessage,
	RuntimeStateStreamTaskSessionsMessage,
	RuntimeStateStreamWorkspaceMetadataMessage,
	RuntimeStateStreamWorkspaceStateMessage,
	RuntimeTaskSessionSummary,
	RuntimeWorkspaceStateResponse,
} from "../core/api-contract.js";
import type { TerminalSessionManager } from "../terminal/session-manager.js";
import { createWorkspaceMetadataMonitor } from "./workspace-metadata-monitor.js";
import type { ResolvedWorkspaceStreamTarget, WorkspaceRegistry } from "./workspace-registry.js";

const TASK_SESSION_STREAM_BATCH_MS = 150;

export interface DisposeRuntimeStateWorkspaceOptions {
	disconnectClients?: boolean;
	closeClientErrorMessage?: string;
}

export interface CreateRuntimeStateHubDependencies {
	workspaceRegistry: Pick<
		WorkspaceRegistry,
		"resolveWorkspaceForStream" | "buildProjectsPayload" | "buildWorkspaceStateSnapshot" | "buildAggregateBoardSnapshot"
	>;
}

export interface RuntimeStateHub {
	trackTerminalManager: (workspaceId: string, manager: TerminalSessionManager) => void;
	handleUpgrade: (
		request: IncomingMessage,
		socket: Parameters<WebSocketServer["handleUpgrade"]>[1],
		head: Buffer,
		context: {
			requestedWorkspaceId: string | null;
			isAggregateView?: boolean;
		},
	) => void;
	disposeWorkspace: (workspaceId: string, options?: DisposeRuntimeStateWorkspaceOptions) => void;
	broadcastRuntimeWorkspaceStateUpdated: (workspaceId: string, workspacePath: string) => Promise<void>;
	broadcastRuntimeProjectsUpdated: (preferredCurrentProjectId: string | null) => Promise<void>;
	broadcastTaskReadyForReview: (workspaceId: string, taskId: string) => void;
	close: () => Promise<void>;
}

export function createRuntimeStateHub(deps: CreateRuntimeStateHubDependencies): RuntimeStateHub {
	const terminalSummaryUnsubscribeByWorkspaceId = new Map<string, () => void>();
	const previousTaskSessionSummaryByWorkspaceId = new Map<string, Map<string, RuntimeTaskSessionSummary>>();
	const pendingTaskSessionSummariesByWorkspaceId = new Map<string, Map<string, RuntimeTaskSessionSummary>>();
	const taskSessionBroadcastTimersByWorkspaceId = new Map<string, NodeJS.Timeout>();
	const runtimeStateClientsByWorkspaceId = new Map<string, Set<WebSocket>>();
	const aggregateRuntimeStateClients = new Set<WebSocket>();
	const runtimeStateClients = new Set<WebSocket>();
	const runtimeStateWorkspaceIdByClient = new Map<WebSocket, string>();
	const runtimeProjectsPayloadCache = {
		payload: null as RuntimeStateStreamProjectsMessage | null,
		inFlight: null as Promise<RuntimeStateStreamProjectsMessage> | null,
	};
	const aggregateSnapshotCache = {
		snapshot: null as {
			board: RuntimeStateStreamAggregateSnapshotMessage["board"];
			generatedAt: number;
		} | null,
		inFlight: null as Promise<{
			board: RuntimeStateStreamAggregateSnapshotMessage["board"];
			generatedAt: number;
		}> | null,
	};
	const workspaceStateSnapshotCache = new Map<string, RuntimeWorkspaceStateResponse>();
	const workspaceStateSnapshotInFlightByWorkspaceId = new Map<string, Promise<RuntimeWorkspaceStateResponse>>();
	const runtimeProjectsBroadcastState = {
		inFlight: null as Promise<void> | null,
		pendingPreferredCurrentProjectId: undefined as string | null | undefined,
	};
	const aggregateBoardBroadcastState = {
		timer: null as NodeJS.Timeout | null,
	};
	const runtimeStateWebSocketServer = new WebSocketServer({ noServer: true });
	const workspaceMetadataMonitor = createWorkspaceMetadataMonitor({
		onMetadataUpdated: (workspaceId, workspaceMetadata) => {
			const clients = runtimeStateClientsByWorkspaceId.get(workspaceId);
			if (!clients || clients.size === 0) {
				queueAggregateBoardUpdated();
				return;
			}
			const payload: RuntimeStateStreamWorkspaceMetadataMessage = {
				type: "workspace_metadata_updated",
				workspaceId,
				workspaceMetadata,
			};
			for (const client of clients) {
				sendRuntimeStateMessage(client, payload);
			}
			queueAggregateBoardUpdated();
		},
	});

	const sendRuntimeStateMessage = (client: WebSocket, payload: RuntimeStateStreamMessage) => {
		if (client.readyState !== WebSocket.OPEN) {
			return;
		}
		try {
			client.send(JSON.stringify(payload));
		} catch {
			// Ignore websocket write errors; close handlers clean up disconnected sockets.
		}
	};

	const adaptProjectsPayloadForPreferredWorkspace = (
		payload: RuntimeStateStreamProjectsMessage,
		preferredCurrentProjectId: string | null,
	): RuntimeStateStreamProjectsMessage => {
		if (!preferredCurrentProjectId) {
			return payload;
		}
		if (!payload.projects.some((project) => project.id === preferredCurrentProjectId)) {
			return payload;
		}
		if (payload.currentProjectId === preferredCurrentProjectId) {
			return payload;
		}
		return {
			...payload,
			currentProjectId: preferredCurrentProjectId,
		};
	};

	const getProjectsPayload = async (preferredCurrentProjectId: string | null): Promise<RuntimeStateStreamProjectsMessage> => {
		const cachedPayload = runtimeProjectsPayloadCache.payload;
		if (cachedPayload) {
			return adaptProjectsPayloadForPreferredWorkspace(cachedPayload, preferredCurrentProjectId);
		}
		if (!runtimeProjectsPayloadCache.inFlight) {
			runtimeProjectsPayloadCache.inFlight = deps.workspaceRegistry
				.buildProjectsPayload(preferredCurrentProjectId)
				.then((payload) => {
					const message: RuntimeStateStreamProjectsMessage = {
						type: "projects_updated",
						currentProjectId: payload.currentProjectId,
						projects: payload.projects,
					};
					runtimeProjectsPayloadCache.payload = message;
					return message;
				})
				.finally(() => {
					runtimeProjectsPayloadCache.inFlight = null;
				});
		}
		const payload = await runtimeProjectsPayloadCache.inFlight;
		return adaptProjectsPayloadForPreferredWorkspace(payload, preferredCurrentProjectId);
	};

	const getAggregateSnapshot = async (): Promise<{
		board: RuntimeStateStreamAggregateSnapshotMessage["board"];
		generatedAt: number;
	}> => {
		if (aggregateSnapshotCache.snapshot) {
			return aggregateSnapshotCache.snapshot;
		}
		if (!aggregateSnapshotCache.inFlight) {
			aggregateSnapshotCache.inFlight = deps.workspaceRegistry
				.buildAggregateBoardSnapshot()
				.then((snapshot) => {
					aggregateSnapshotCache.snapshot = snapshot;
					return snapshot;
				})
				.finally(() => {
					aggregateSnapshotCache.inFlight = null;
				});
		}
		return await aggregateSnapshotCache.inFlight;
	};

	const getWorkspaceStateSnapshot = async (
		workspaceId: string,
		workspacePath: string,
	): Promise<RuntimeWorkspaceStateResponse> => {
		const cachedSnapshot = workspaceStateSnapshotCache.get(workspaceId);
		if (cachedSnapshot) {
			return cachedSnapshot;
		}
		const inFlightSnapshot = workspaceStateSnapshotInFlightByWorkspaceId.get(workspaceId);
		if (inFlightSnapshot) {
			return await inFlightSnapshot;
		}
		const nextSnapshotPromise = deps.workspaceRegistry
			.buildWorkspaceStateSnapshot(workspaceId, workspacePath)
			.then((snapshot) => {
				workspaceStateSnapshotCache.set(workspaceId, snapshot);
				return snapshot;
			})
			.finally(() => {
				workspaceStateSnapshotInFlightByWorkspaceId.delete(workspaceId);
			});
		workspaceStateSnapshotInFlightByWorkspaceId.set(workspaceId, nextSnapshotPromise);
		return await nextSnapshotPromise;
	};

	const runRuntimeProjectsUpdatedBroadcast = async (preferredCurrentProjectId: string | null): Promise<void> => {
		if (runtimeStateClients.size === 0) {
			return;
		}
		try {
			const nextPayload = await deps.workspaceRegistry.buildProjectsPayload(preferredCurrentProjectId);
			const payload: RuntimeStateStreamProjectsMessage = {
				type: "projects_updated",
				currentProjectId: nextPayload.currentProjectId,
				projects: nextPayload.projects,
			};
			runtimeProjectsPayloadCache.payload = payload;
			for (const client of runtimeStateClients) {
				sendRuntimeStateMessage(client, payload);
			}
		} catch {
			// Ignore transient project summary failures; next update will resync.
		}
		queueAggregateBoardUpdated();
	};

	const broadcastRuntimeProjectsUpdated = async (preferredCurrentProjectId: string | null): Promise<void> => {
		runtimeProjectsBroadcastState.pendingPreferredCurrentProjectId = preferredCurrentProjectId;
		if (runtimeProjectsBroadcastState.inFlight) {
			await runtimeProjectsBroadcastState.inFlight;
			return;
		}
		runtimeProjectsBroadcastState.inFlight = (async () => {
			while (runtimeProjectsBroadcastState.pendingPreferredCurrentProjectId !== undefined) {
				const nextPreferredCurrentProjectId = runtimeProjectsBroadcastState.pendingPreferredCurrentProjectId;
				runtimeProjectsBroadcastState.pendingPreferredCurrentProjectId = undefined;
				await runRuntimeProjectsUpdatedBroadcast(nextPreferredCurrentProjectId ?? null);
			}
		})().finally(() => {
			runtimeProjectsBroadcastState.inFlight = null;
		});
		await runtimeProjectsBroadcastState.inFlight;
	};

	const broadcastAggregateBoardUpdated = async (): Promise<void> => {
		if (aggregateRuntimeStateClients.size === 0) {
			return;
		}
		try {
			const snapshot = await deps.workspaceRegistry.buildAggregateBoardSnapshot();
			aggregateSnapshotCache.snapshot = snapshot;
			for (const client of aggregateRuntimeStateClients) {
				sendRuntimeStateMessage(client, {
					type: "aggregate_board_updated",
					board: snapshot.board,
					generatedAt: snapshot.generatedAt,
				} satisfies RuntimeStateStreamAggregateBoardUpdatedMessage);
			}
		} catch {
			// Ignore transient aggregate board build failures; next update will resync.
		}
	};

	const queueAggregateBoardUpdated = () => {
		if (aggregateRuntimeStateClients.size === 0 || aggregateBoardBroadcastState.timer) {
			return;
		}
		const timer = setTimeout(() => {
			aggregateBoardBroadcastState.timer = null;
			void broadcastAggregateBoardUpdated();
		}, TASK_SESSION_STREAM_BATCH_MS);
		timer.unref();
		aggregateBoardBroadcastState.timer = timer;
	};

	const flushTaskSessionSummaries = (workspaceId: string) => {
		const pending = pendingTaskSessionSummariesByWorkspaceId.get(workspaceId);
		if (!pending || pending.size === 0) {
			return;
		}
		pendingTaskSessionSummariesByWorkspaceId.delete(workspaceId);
		const summaries = Array.from(pending.values());
		const cachedWorkspaceState = workspaceStateSnapshotCache.get(workspaceId);
		if (cachedWorkspaceState) {
			const nextSessions = {
				...cachedWorkspaceState.sessions,
			};
			for (const summary of summaries) {
				nextSessions[summary.taskId] = summary;
			}
			workspaceStateSnapshotCache.set(workspaceId, {
				...cachedWorkspaceState,
				sessions: nextSessions,
			});
		}
		const runtimeClients = runtimeStateClientsByWorkspaceId.get(workspaceId);
		if (runtimeClients && runtimeClients.size > 0) {
			const payload: RuntimeStateStreamTaskSessionsMessage = {
				type: "task_sessions_updated",
				workspaceId,
				summaries,
			};
			for (const client of runtimeClients) {
				sendRuntimeStateMessage(client, payload);
			}
		}
		void broadcastRuntimeProjectsUpdated(workspaceId);
		queueAggregateBoardUpdated();
	};

	const queueTaskSessionSummaryBroadcast = (workspaceId: string, summary: RuntimeTaskSessionSummary) => {
		const pending =
			pendingTaskSessionSummariesByWorkspaceId.get(workspaceId) ?? new Map<string, RuntimeTaskSessionSummary>();
		pending.set(summary.taskId, summary);
		pendingTaskSessionSummariesByWorkspaceId.set(workspaceId, pending);
		if (taskSessionBroadcastTimersByWorkspaceId.has(workspaceId)) {
			return;
		}
		const timer = setTimeout(() => {
			taskSessionBroadcastTimersByWorkspaceId.delete(workspaceId);
			flushTaskSessionSummaries(workspaceId);
		}, TASK_SESSION_STREAM_BATCH_MS);
		timer.unref();
		taskSessionBroadcastTimersByWorkspaceId.set(workspaceId, timer);
	};

	const disposeTaskSessionSummaryBroadcast = (workspaceId: string) => {
		const timer = taskSessionBroadcastTimersByWorkspaceId.get(workspaceId);
		if (timer) {
			clearTimeout(timer);
		}
		taskSessionBroadcastTimersByWorkspaceId.delete(workspaceId);
		pendingTaskSessionSummariesByWorkspaceId.delete(workspaceId);
	};

	const cleanupRuntimeStateClient = (client: WebSocket) => {
		const workspaceId = runtimeStateWorkspaceIdByClient.get(client);
		if (workspaceId) {
			workspaceMetadataMonitor.disconnectWorkspace(workspaceId);
			const clients = runtimeStateClientsByWorkspaceId.get(workspaceId);
			if (clients) {
				clients.delete(client);
				if (clients.size === 0) {
					runtimeStateClientsByWorkspaceId.delete(workspaceId);
				}
			}
		}
		aggregateRuntimeStateClients.delete(client);
		runtimeStateWorkspaceIdByClient.delete(client);
		runtimeStateClients.delete(client);
	};

	const disposeWorkspace = (workspaceId: string, options?: DisposeRuntimeStateWorkspaceOptions) => {
		const unsubscribeSummary = terminalSummaryUnsubscribeByWorkspaceId.get(workspaceId);
		if (unsubscribeSummary) {
			try {
				unsubscribeSummary();
			} catch {
				// Ignore listener cleanup errors during project removal.
			}
		}
		terminalSummaryUnsubscribeByWorkspaceId.delete(workspaceId);
		previousTaskSessionSummaryByWorkspaceId.delete(workspaceId);
		disposeTaskSessionSummaryBroadcast(workspaceId);
		workspaceStateSnapshotCache.delete(workspaceId);
		workspaceStateSnapshotInFlightByWorkspaceId.delete(workspaceId);
		workspaceMetadataMonitor.disposeWorkspace(workspaceId);

		if (!options?.disconnectClients) {
			return;
		}

		const runtimeClients = runtimeStateClientsByWorkspaceId.get(workspaceId);
		if (!runtimeClients || runtimeClients.size === 0) {
			runtimeStateClientsByWorkspaceId.delete(workspaceId);
			return;
		}

		for (const runtimeClient of runtimeClients) {
			if (options.closeClientErrorMessage) {
				sendRuntimeStateMessage(runtimeClient, {
					type: "error",
					message: options.closeClientErrorMessage,
				} satisfies RuntimeStateStreamErrorMessage);
			}
			try {
				runtimeClient.close();
			} catch {
				// Ignore close failures while disposing removed workspace clients.
			}
			cleanupRuntimeStateClient(runtimeClient);
		}
		runtimeStateClientsByWorkspaceId.delete(workspaceId);
		queueAggregateBoardUpdated();
	};

	const broadcastRuntimeWorkspaceStateUpdated = async (workspaceId: string, workspacePath: string): Promise<void> => {
		const clients = runtimeStateClientsByWorkspaceId.get(workspaceId);
		try {
			const workspaceState = await deps.workspaceRegistry.buildWorkspaceStateSnapshot(workspaceId, workspacePath);
			workspaceStateSnapshotCache.set(workspaceId, workspaceState);
			if (clients && clients.size > 0) {
				const payload: RuntimeStateStreamWorkspaceStateMessage = {
					type: "workspace_state_updated",
					workspaceId,
					workspaceState,
				};
				for (const client of clients) {
					sendRuntimeStateMessage(client, payload);
				}
			}
			await workspaceMetadataMonitor.updateWorkspaceState({
				workspaceId,
				workspacePath,
				board: workspaceState.board,
			});
			queueAggregateBoardUpdated();
		} catch {
			// Ignore transient state read failures; next update will resync.
		}
	};

	const broadcastTaskReadyForReview = (workspaceId: string, taskId: string) => {
		const runtimeClients = runtimeStateClientsByWorkspaceId.get(workspaceId);
		if (!runtimeClients || runtimeClients.size === 0) {
			return;
		}
		const payload: RuntimeStateStreamTaskReadyForReviewMessage = {
			type: "task_ready_for_review",
			workspaceId,
			taskId,
			triggeredAt: Date.now(),
		};
		for (const client of runtimeClients) {
			sendRuntimeStateMessage(client, payload);
		}
	};

	runtimeStateWebSocketServer.on("connection", async (client: WebSocket, context: unknown) => {
		client.on("close", () => {
			cleanupRuntimeStateClient(client);
		});
		try {
			const isAggregateView =
				typeof context === "object" &&
				context !== null &&
				"isAggregateView" in context &&
				(context as { isAggregateView?: unknown }).isAggregateView === true;
			const requestedWorkspaceId =
				typeof context === "object" &&
				context !== null &&
				"requestedWorkspaceId" in context &&
				typeof (context as { requestedWorkspaceId?: unknown }).requestedWorkspaceId === "string"
					? (context as { requestedWorkspaceId: string }).requestedWorkspaceId || null
					: null;
			if (isAggregateView) {
				const [projectsPayload, aggregateSnapshot] = await Promise.all([
					getProjectsPayload(null),
					getAggregateSnapshot(),
				]);
				if (client.readyState !== WebSocket.OPEN) {
					cleanupRuntimeStateClient(client);
					return;
				}
				sendRuntimeStateMessage(client, {
					type: "aggregate_snapshot",
					projects: projectsPayload.projects,
					board: aggregateSnapshot.board,
					generatedAt: aggregateSnapshot.generatedAt,
				} satisfies RuntimeStateStreamAggregateSnapshotMessage);
				if (client.readyState !== WebSocket.OPEN) {
					cleanupRuntimeStateClient(client);
					return;
				}
				runtimeStateClients.add(client);
				aggregateRuntimeStateClients.add(client);
				return;
			}
			const workspace: ResolvedWorkspaceStreamTarget = await deps.workspaceRegistry.resolveWorkspaceForStream(
				requestedWorkspaceId,
				{
					onRemovedWorkspace: ({ workspaceId, message }) => {
						disposeWorkspace(workspaceId, {
							disconnectClients: true,
							closeClientErrorMessage: message,
						});
					},
				},
			);
			if (client.readyState !== WebSocket.OPEN) {
				cleanupRuntimeStateClient(client);
				return;
			}

			/*
				Connection setup for workspace-scoped runtime streams is intentionally split into two phases.

				We need the initial snapshot to already contain the first workspace metadata payload, but we do not want
				the client to receive a separate "workspace_metadata_updated" event before that snapshot arrives.

				That race can happen if we register the websocket in runtimeStateClientsByWorkspaceId first and then call
				workspaceMetadataMonitor.connectWorkspace(...). connectWorkspace() performs an immediate refresh, and that
				refresh may broadcast "workspace_metadata_updated" to every currently registered workspace client. In that
				old ordering, a newly connected client could observe:

				1. workspace_metadata_updated
				2. snapshot

				which makes the initial load look wrong and forces the UI to process the same logical data twice in the
				opposite order from what readers expect.

				To avoid that, we:

				1. build workspace state and connect the metadata monitor to get the initial metadata snapshot
				2. send the combined "snapshot" message
				3. only then register the socket in runtimeStateClients and runtimeStateClientsByWorkspaceId so
				   future incremental projects_updated and workspace_metadata_updated events can flow normally

				The extra readyState checks and monitor cleanup below are paired with this delayed registration. If the
				socket closes while we are still assembling or sending the initial snapshot, we must disconnect the
				temporary metadata monitor subscription before returning, otherwise we would leave behind subscriber count
				state for a client that never finished the handshake.
			*/
			let monitorWorkspaceId: string | null = null;
			let didConnectWorkspaceMonitor = false;

			try {
				let projectsPayload: {
					currentProjectId: string | null;
					projects: RuntimeStateStreamProjectsMessage["projects"];
				};
				let workspaceState: RuntimeStateStreamSnapshotMessage["workspaceState"];
				let workspaceMetadata: RuntimeStateStreamSnapshotMessage["workspaceMetadata"];
				if (workspace.workspaceId && workspace.workspacePath) {
					monitorWorkspaceId = workspace.workspaceId;
					[projectsPayload, workspaceState] = await Promise.all([
						getProjectsPayload(workspace.workspaceId),
						getWorkspaceStateSnapshot(workspace.workspaceId, workspace.workspacePath),
					]);
					workspaceMetadata = await workspaceMetadataMonitor.connectWorkspace({
						workspaceId: workspace.workspaceId,
						workspacePath: workspace.workspacePath,
						board: workspaceState.board,
					});
					didConnectWorkspaceMonitor = true;
				} else {
					projectsPayload = await getProjectsPayload(null);
					workspaceState = null;
					workspaceMetadata = null;
				}
				if (client.readyState !== WebSocket.OPEN) {
					if (monitorWorkspaceId) {
						workspaceMetadataMonitor.disconnectWorkspace(monitorWorkspaceId);
					}
					cleanupRuntimeStateClient(client);
					return;
				}
				sendRuntimeStateMessage(client, {
					type: "snapshot",
					currentProjectId: projectsPayload.currentProjectId,
					projects: projectsPayload.projects,
					workspaceState,
					workspaceMetadata,
				} satisfies RuntimeStateStreamSnapshotMessage);
				if (client.readyState !== WebSocket.OPEN) {
					if (monitorWorkspaceId) {
						workspaceMetadataMonitor.disconnectWorkspace(monitorWorkspaceId);
					}
					cleanupRuntimeStateClient(client);
					return;
				}
				runtimeStateClients.add(client);
				if (monitorWorkspaceId) {
					const workspaceClients =
						runtimeStateClientsByWorkspaceId.get(monitorWorkspaceId) ?? new Set<WebSocket>();
					workspaceClients.add(client);
					runtimeStateClientsByWorkspaceId.set(monitorWorkspaceId, workspaceClients);
					runtimeStateWorkspaceIdByClient.set(client, monitorWorkspaceId);
					const taskSessionSummaries = Array.from(
						previousTaskSessionSummaryByWorkspaceId.get(monitorWorkspaceId)?.values() ?? [],
					);
					if (taskSessionSummaries.length > 0) {
						sendRuntimeStateMessage(client, {
							type: "task_sessions_updated",
							workspaceId: monitorWorkspaceId,
							summaries: taskSessionSummaries,
						} satisfies RuntimeStateStreamTaskSessionsMessage);
					}
				}
				if (workspace.removedRequestedWorkspacePath) {
					sendRuntimeStateMessage(client, {
						type: "error",
						message: `Project no longer exists on disk and was removed: ${workspace.removedRequestedWorkspacePath}`,
					} satisfies RuntimeStateStreamErrorMessage);
				}
				if (workspace.didPruneProjects) {
					void broadcastRuntimeProjectsUpdated(workspace.workspaceId);
				}
			} catch (error) {
				if (didConnectWorkspaceMonitor && monitorWorkspaceId) {
					workspaceMetadataMonitor.disconnectWorkspace(monitorWorkspaceId);
				}
				const message = error instanceof Error ? error.message : String(error);
				sendRuntimeStateMessage(client, {
					type: "error",
					message,
				} satisfies RuntimeStateStreamErrorMessage);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendRuntimeStateMessage(client, {
				type: "error",
				message,
			} satisfies RuntimeStateStreamErrorMessage);
			client.close();
		}
	});

	return {
		trackTerminalManager: (workspaceId: string, manager: TerminalSessionManager) => {
			if (terminalSummaryUnsubscribeByWorkspaceId.has(workspaceId)) {
				return;
			}
			const previousSummariesByTaskId = new Map<string, RuntimeTaskSessionSummary>();
			previousTaskSessionSummaryByWorkspaceId.set(workspaceId, previousSummariesByTaskId);
			for (const summary of manager.listSummaries()) {
				previousSummariesByTaskId.set(summary.taskId, summary);
				queueTaskSessionSummaryBroadcast(workspaceId, summary);
			}
			const unsubscribe = manager.onSummary((summary) => {
				previousSummariesByTaskId.set(summary.taskId, summary);
				queueTaskSessionSummaryBroadcast(workspaceId, summary);
			});
			terminalSummaryUnsubscribeByWorkspaceId.set(workspaceId, unsubscribe);
		},
		handleUpgrade: (request, socket, head, context) => {
			runtimeStateWebSocketServer.handleUpgrade(request, socket, head, (ws) => {
				runtimeStateWebSocketServer.emit("connection", ws, context);
			});
		},
		disposeWorkspace,
		broadcastRuntimeWorkspaceStateUpdated,
		broadcastRuntimeProjectsUpdated,
		broadcastTaskReadyForReview,
		close: async () => {
			if (aggregateBoardBroadcastState.timer) {
				clearTimeout(aggregateBoardBroadcastState.timer);
				aggregateBoardBroadcastState.timer = null;
			}
			for (const timer of taskSessionBroadcastTimersByWorkspaceId.values()) {
				clearTimeout(timer);
			}
			taskSessionBroadcastTimersByWorkspaceId.clear();
			pendingTaskSessionSummariesByWorkspaceId.clear();
			runtimeProjectsBroadcastState.pendingPreferredCurrentProjectId = undefined;
			runtimeProjectsPayloadCache.payload = null;
			aggregateSnapshotCache.snapshot = null;
			workspaceStateSnapshotCache.clear();
			workspaceStateSnapshotInFlightByWorkspaceId.clear();
			for (const unsubscribe of terminalSummaryUnsubscribeByWorkspaceId.values()) {
				try {
					unsubscribe();
				} catch {
					// Ignore listener cleanup errors during shutdown.
				}
			}
			terminalSummaryUnsubscribeByWorkspaceId.clear();
			previousTaskSessionSummaryByWorkspaceId.clear();
			workspaceMetadataMonitor.close();
			for (const client of runtimeStateClients) {
				try {
					client.terminate();
				} catch {
					// Ignore websocket termination errors during shutdown.
				}
			}
			runtimeStateClients.clear();
			aggregateRuntimeStateClients.clear();
			runtimeStateClientsByWorkspaceId.clear();
			runtimeStateWorkspaceIdByClient.clear();
			await new Promise<void>((resolveCloseWebSockets) => {
				runtimeStateWebSocketServer.close(() => {
					resolveCloseWebSockets();
				});
			});
		},
	};
}
