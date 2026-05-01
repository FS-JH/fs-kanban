import { useCallback, useEffect, useReducer } from "react";

import type {
	RuntimeApprovalRequest,
	RuntimeProjectSummary,
	RuntimeStateStreamMessage,
	RuntimeStateStreamProjectsMessage,
	RuntimeStateStreamSnapshotMessage,
	RuntimeStateStreamTaskReadyForReviewMessage,
	RuntimeTaskSessionSummary,
	RuntimeWorkspaceMetadata,
	RuntimeWorkspaceStateResponse,
} from "@/runtime/types";

const STREAM_RECONNECT_BASE_DELAY_MS = 500;
const STREAM_RECONNECT_MAX_DELAY_MS = 5_000;

function mergeTaskSessionSummaries(
	currentSessions: Record<string, RuntimeTaskSessionSummary>,
	summaries: RuntimeTaskSessionSummary[],
): Record<string, RuntimeTaskSessionSummary> {
	if (summaries.length === 0) {
		return currentSessions;
	}
	const nextSessions = { ...currentSessions };
	for (const summary of summaries) {
		const existing = nextSessions[summary.taskId];
		if (!existing || existing.updatedAt <= summary.updatedAt) {
			nextSessions[summary.taskId] = summary;
		}
	}
	return nextSessions;
}

function getRuntimeStreamUrl(workspaceId: string | null): string {
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const url = new URL(`${protocol}//${window.location.host}/api/runtime/ws`);
	if (workspaceId) {
		url.searchParams.set("workspaceId", workspaceId);
	}
	return url.toString();
}

export interface ApprovalQueueState {
	pending: RuntimeApprovalRequest[];
	recent: RuntimeApprovalRequest[];
}

const RECENT_APPROVAL_LIMIT = 50;

export interface UseRuntimeStateStreamResult {
	currentProjectId: string | null;
	projects: RuntimeProjectSummary[];
	workspaceState: RuntimeWorkspaceStateResponse | null;
	workspaceMetadata: RuntimeWorkspaceMetadata | null;
	latestTaskReadyForReview: RuntimeStateStreamTaskReadyForReviewMessage | null;
	approvalQueueState: ApprovalQueueState;
	dispatchSeedApprovals: (input: ApprovalQueueState) => void;
	streamError: string | null;
	isRuntimeDisconnected: boolean;
	hasReceivedSnapshot: boolean;
}

interface RuntimeStateStreamStore {
	currentProjectId: string | null;
	projects: RuntimeProjectSummary[];
	workspaceState: RuntimeWorkspaceStateResponse | null;
	workspaceMetadata: RuntimeWorkspaceMetadata | null;
	latestTaskReadyForReview: RuntimeStateStreamTaskReadyForReviewMessage | null;
	approvalQueueState: ApprovalQueueState;
	streamError: string | null;
	isRuntimeDisconnected: boolean;
	hasReceivedSnapshot: boolean;
}

type RuntimeStateStreamAction =
	| { type: "requested_workspace_changed" }
	| { type: "stream_connected" }
	| { type: "snapshot"; payload: RuntimeStateStreamSnapshotMessage }
	| {
			type: "projects_updated";
			payload: RuntimeStateStreamProjectsMessage;
			nextProjectId: string | null;
	  }
	| { type: "workspace_metadata_updated"; workspaceMetadata: RuntimeWorkspaceMetadata }
	| { type: "task_ready_for_review"; payload: RuntimeStateStreamTaskReadyForReviewMessage }
	| { type: "workspace_state_updated"; workspaceState: RuntimeWorkspaceStateResponse }
	| { type: "task_sessions_updated"; summaries: RuntimeTaskSessionSummary[] }
	| { type: "approval_request_queued"; request: RuntimeApprovalRequest }
	| { type: "approval_request_decided"; request: RuntimeApprovalRequest }
	| { type: "seed_approvals"; pending: RuntimeApprovalRequest[]; recent: RuntimeApprovalRequest[] }
	| { type: "stream_error"; message: string }
	| { type: "stream_disconnected"; message: string };

function createInitialRuntimeStateStreamStore(requestedWorkspaceId: string | null): RuntimeStateStreamStore {
	return {
		currentProjectId: requestedWorkspaceId,
		projects: [],
		workspaceState: null,
		workspaceMetadata: null,
		latestTaskReadyForReview: null,
		approvalQueueState: { pending: [], recent: [] },
		streamError: null,
		isRuntimeDisconnected: false,
		hasReceivedSnapshot: false,
	};
}

function resolveProjectIdAfterProjectsUpdate(
	currentProjectId: string | null,
	payload: RuntimeStateStreamProjectsMessage,
): string | null {
	if (currentProjectId && payload.projects.some((project) => project.id === currentProjectId)) {
		return currentProjectId;
	}
	return payload.currentProjectId;
}

function runtimeStateStreamReducer(
	state: RuntimeStateStreamStore,
	action: RuntimeStateStreamAction,
): RuntimeStateStreamStore {
	if (action.type === "requested_workspace_changed") {
		return {
			...state,
			workspaceState: null,
			workspaceMetadata: null,
			streamError: null,
			isRuntimeDisconnected: false,
			hasReceivedSnapshot: false,
		};
	}
	if (action.type === "stream_connected") {
		return {
			...state,
			streamError: null,
			isRuntimeDisconnected: false,
		};
	}
	if (action.type === "snapshot") {
		const nextWorkspaceState = action.payload.workspaceState
			? {
					...action.payload.workspaceState,
					sessions: mergeTaskSessionSummaries(
						state.workspaceState?.sessions ?? {},
						Object.values(action.payload.workspaceState.sessions ?? {}),
					),
				}
			: null;
		return {
			currentProjectId: action.payload.currentProjectId,
			projects: action.payload.projects,
			workspaceState: nextWorkspaceState,
			workspaceMetadata: action.payload.workspaceMetadata,
			latestTaskReadyForReview: state.latestTaskReadyForReview,
			approvalQueueState: state.approvalQueueState,
			streamError: null,
			isRuntimeDisconnected: false,
			hasReceivedSnapshot: true,
		};
	}
	if (action.type === "projects_updated") {
		const didProjectChange = action.nextProjectId !== state.currentProjectId;
		return {
			...state,
			currentProjectId: action.nextProjectId,
			projects: action.payload.projects,
			workspaceState: didProjectChange ? null : state.workspaceState,
			workspaceMetadata: didProjectChange ? null : state.workspaceMetadata,
			latestTaskReadyForReview: didProjectChange ? null : state.latestTaskReadyForReview,
			hasReceivedSnapshot: true,
		};
	}
	if (action.type === "workspace_metadata_updated") {
		return {
			...state,
			workspaceMetadata: action.workspaceMetadata,
		};
	}
	if (action.type === "task_ready_for_review") {
		return {
			...state,
			latestTaskReadyForReview: action.payload,
		};
	}
	if (action.type === "workspace_state_updated") {
		const mergedWorkspaceState = {
			...action.workspaceState,
			sessions: mergeTaskSessionSummaries(
				state.workspaceState?.sessions ?? {},
				Object.values(action.workspaceState.sessions ?? {}),
			),
		};
		return {
			...state,
			workspaceState: mergedWorkspaceState,
		};
	}
	if (action.type === "task_sessions_updated") {
		if (!state.workspaceState) {
			return state;
		}
		return {
			...state,
			workspaceState: {
				...state.workspaceState,
				sessions: mergeTaskSessionSummaries(state.workspaceState.sessions, action.summaries),
			},
		};
	}
	if (action.type === "approval_request_queued") {
		const { request } = action;
		const pending = [...state.approvalQueueState.pending.filter((entry) => entry.id !== request.id), request];
		const recent = state.approvalQueueState.recent.filter((entry) => entry.id !== request.id);
		return {
			...state,
			approvalQueueState: { pending, recent },
		};
	}
	if (action.type === "approval_request_decided") {
		const { request } = action;
		const pending = state.approvalQueueState.pending.filter((entry) => entry.id !== request.id);
		const recent = [request, ...state.approvalQueueState.recent.filter((entry) => entry.id !== request.id)].slice(
			0,
			RECENT_APPROVAL_LIMIT,
		);
		return {
			...state,
			approvalQueueState: { pending, recent },
		};
	}
	if (action.type === "seed_approvals") {
		// Merge seed (snapshot from initial tRPC fetch) with current live state
		// (driven by WS events). Rule: a "decided" status (auto/user_approved/denied,
		// timed_out) ALWAYS wins over "pending" — both directions — so neither
		// stale seeds nor stale live states can keep a request in the wrong bucket.
		const byId = new Map<string, RuntimeApprovalRequest>();
		const apply = (entry: RuntimeApprovalRequest): void => {
			const existing = byId.get(entry.id);
			if (!existing) {
				byId.set(entry.id, entry);
				return;
			}
			// Decided beats pending regardless of source.
			if (existing.status !== "pending" && entry.status === "pending") return;
			if (existing.status === "pending" && entry.status !== "pending") {
				byId.set(entry.id, entry);
				return;
			}
			// Same bucket: prefer the latest (highest decidedAt for decided, or
			// keep newer createdAt for pending).
			if (entry.status === "pending") {
				if (entry.createdAt >= existing.createdAt) byId.set(entry.id, entry);
				return;
			}
			const existingTs = existing.decidedAt ?? 0;
			const entryTs = entry.decidedAt ?? 0;
			if (entryTs >= existingTs) byId.set(entry.id, entry);
		};
		// Apply seed first, then live (live entries always pass the merge guard).
		for (const entry of action.pending) apply(entry);
		for (const entry of action.recent) apply(entry);
		for (const entry of state.approvalQueueState.pending) apply(entry);
		for (const entry of state.approvalQueueState.recent) apply(entry);
		const all = Array.from(byId.values());
		return {
			...state,
			approvalQueueState: {
				pending: all
					.filter((entry) => entry.status === "pending")
					.sort((a, b) => a.createdAt - b.createdAt),
				recent: all
					.filter((entry) => entry.status !== "pending")
					.sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0))
					.slice(0, RECENT_APPROVAL_LIMIT),
			},
		};
	}
	if (action.type === "stream_error") {
		return {
			...state,
			streamError: action.message,
			isRuntimeDisconnected: false,
		};
	}
	if (action.type === "stream_disconnected") {
		return {
			...state,
			streamError: action.message,
			isRuntimeDisconnected: true,
		};
	}
	return state;
}

export function useRuntimeStateStream(requestedWorkspaceId: string | null): UseRuntimeStateStreamResult {
	const [state, dispatch] = useReducer(
		runtimeStateStreamReducer,
		requestedWorkspaceId,
		createInitialRuntimeStateStreamStore,
	);

	useEffect(() => {
		let cancelled = false;
		let socket: WebSocket | null = null;
		let reconnectTimer: number | null = null;
		let reconnectAttempt = 0;
		let activeWorkspaceId = requestedWorkspaceId;
		let requestedWorkspaceForConnection = requestedWorkspaceId;

		dispatch({ type: "requested_workspace_changed" });

		const cleanupSocket = () => {
			if (socket) {
				socket.onopen = null;
				socket.onmessage = null;
				socket.onerror = null;
				socket.onclose = null;
				socket.close();
				socket = null;
			}
		};

		const scheduleReconnect = () => {
			if (cancelled || reconnectTimer !== null) {
				return;
			}
			const delay = Math.min(STREAM_RECONNECT_MAX_DELAY_MS, STREAM_RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempt);
			reconnectAttempt += 1;
			reconnectTimer = window.setTimeout(() => {
				connect();
			}, delay);
		};

		const connect = () => {
			if (cancelled) {
				return;
			}
			if (reconnectTimer !== null) {
				window.clearTimeout(reconnectTimer);
				reconnectTimer = null;
			}
			cleanupSocket();
			try {
				socket = new WebSocket(getRuntimeStreamUrl(requestedWorkspaceForConnection));
			} catch (error) {
				dispatch({
					type: "stream_disconnected",
					message: error instanceof Error ? error.message : String(error),
				});
				scheduleReconnect();
				return;
			}
			socket.onopen = () => {
				reconnectAttempt = 0;
				dispatch({ type: "stream_connected" });
			};
			socket.onmessage = (event) => {
				try {
					const payload = JSON.parse(String(event.data)) as RuntimeStateStreamMessage;
					if (payload.type === "snapshot") {
						activeWorkspaceId = payload.currentProjectId;
						dispatch({ type: "snapshot", payload });
						return;
					}
					if (payload.type === "projects_updated") {
						const previousWorkspaceId = activeWorkspaceId;
						const nextProjectId = resolveProjectIdAfterProjectsUpdate(activeWorkspaceId, payload);
						activeWorkspaceId = nextProjectId;
						dispatch({
							type: "projects_updated",
							payload,
							nextProjectId,
						});
						if (nextProjectId && nextProjectId !== previousWorkspaceId) {
							requestedWorkspaceForConnection = nextProjectId;
							dispatch({ type: "requested_workspace_changed" });
							connect();
						}
						return;
					}
					if (payload.type === "workspace_state_updated") {
						if (payload.workspaceId !== activeWorkspaceId) {
							return;
						}
						dispatch({
							type: "workspace_state_updated",
							workspaceState: payload.workspaceState,
						});
						return;
					}
					if (payload.type === "workspace_metadata_updated") {
						if (payload.workspaceId !== activeWorkspaceId) {
							return;
						}
						dispatch({
							type: "workspace_metadata_updated",
							workspaceMetadata: payload.workspaceMetadata,
						});
						return;
					}
					if (payload.type === "task_sessions_updated") {
						if (payload.workspaceId !== activeWorkspaceId) {
							return;
						}
						dispatch({
							type: "task_sessions_updated",
							summaries: payload.summaries,
						});
						return;
					}
					if (payload.type === "task_ready_for_review") {
						if (payload.workspaceId !== activeWorkspaceId) {
							return;
						}
						dispatch({
							type: "task_ready_for_review",
							payload,
						});
						return;
					}
					if (payload.type === "approval_request_queued") {
						if (payload.workspaceId !== activeWorkspaceId) {
							return;
						}
						dispatch({ type: "approval_request_queued", request: payload.request });
						return;
					}
					if (payload.type === "approval_request_decided") {
						if (payload.workspaceId !== activeWorkspaceId) {
							return;
						}
						dispatch({ type: "approval_request_decided", request: payload.request });
						return;
					}
					if (payload.type === "error") {
						dispatch({
							type: "stream_error",
							message: payload.message,
						});
					}
				} catch {
					// Ignore malformed stream messages.
				}
			};
			socket.onclose = () => {
				if (cancelled) {
					return;
				}
				dispatch({
					type: "stream_disconnected",
					message: "Runtime stream disconnected.",
				});
				scheduleReconnect();
			};
			socket.onerror = () => {
				if (cancelled) {
					return;
				}
				dispatch({
					type: "stream_disconnected",
					message: "Runtime stream connection failed.",
				});
			};
		};

		connect();

		return () => {
			cancelled = true;
			if (reconnectTimer != null) {
				window.clearTimeout(reconnectTimer);
			}
			cleanupSocket();
		};
	}, [requestedWorkspaceId]);

	const dispatchSeedApprovals = useCallback(
		(input: ApprovalQueueState) => {
			dispatch({
				type: "seed_approvals",
				pending: input.pending,
				recent: input.recent,
			});
		},
		[],
	);

	return {
		currentProjectId: state.currentProjectId,
		projects: state.projects,
		workspaceState: state.workspaceState,
		workspaceMetadata: state.workspaceMetadata,
		latestTaskReadyForReview: state.latestTaskReadyForReview,
		approvalQueueState: state.approvalQueueState,
		dispatchSeedApprovals,
		streamError: state.streamError,
		isRuntimeDisconnected: state.isRuntimeDisconnected,
		hasReceivedSnapshot: state.hasReceivedSnapshot,
	};
}
