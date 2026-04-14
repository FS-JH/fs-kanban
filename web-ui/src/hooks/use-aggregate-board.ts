import { useEffect, useReducer } from "react";

import type {
	RuntimeAggregateBoardData,
	RuntimeProjectSummary,
	RuntimeStateStreamAggregateBoardUpdatedMessage,
	RuntimeStateStreamAggregateSnapshotMessage,
	RuntimeStateStreamMessage,
	RuntimeStateStreamProjectsMessage,
} from "@/runtime/types";

const STREAM_RECONNECT_BASE_DELAY_MS = 500;
const STREAM_RECONNECT_MAX_DELAY_MS = 5_000;

function getAggregateRuntimeStreamUrl(): string {
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const url = new URL(`${protocol}//${window.location.host}/api/runtime/ws`);
	url.searchParams.set("view", "all-projects");
	return url.toString();
}

interface AggregateBoardState {
	projects: RuntimeProjectSummary[];
	board: RuntimeAggregateBoardData | null;
	generatedAt: number | null;
	streamError: string | null;
	isRuntimeDisconnected: boolean;
	hasReceivedSnapshot: boolean;
}

type AggregateBoardAction =
	| { type: "stream_connected" }
	| { type: "aggregate_snapshot"; payload: RuntimeStateStreamAggregateSnapshotMessage }
	| { type: "aggregate_board_updated"; payload: RuntimeStateStreamAggregateBoardUpdatedMessage }
	| { type: "projects_updated"; payload: RuntimeStateStreamProjectsMessage }
	| { type: "stream_error"; message: string }
	| { type: "stream_disconnected"; message: string };

function createInitialAggregateBoardState(): AggregateBoardState {
	return {
		projects: [],
		board: null,
		generatedAt: null,
		streamError: null,
		isRuntimeDisconnected: false,
		hasReceivedSnapshot: false,
	};
}

function aggregateBoardReducer(state: AggregateBoardState, action: AggregateBoardAction): AggregateBoardState {
	if (action.type === "stream_connected") {
		return {
			...state,
			streamError: null,
			isRuntimeDisconnected: false,
		};
	}
	if (action.type === "aggregate_snapshot") {
		return {
			projects: action.payload.projects,
			board: action.payload.board,
			generatedAt: action.payload.generatedAt,
			streamError: null,
			isRuntimeDisconnected: false,
			hasReceivedSnapshot: true,
		};
	}
	if (action.type === "aggregate_board_updated") {
		return {
			...state,
			board: action.payload.board,
			generatedAt: action.payload.generatedAt,
			hasReceivedSnapshot: true,
		};
	}
	if (action.type === "projects_updated") {
		return {
			...state,
			projects: action.payload.projects,
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

export interface UseAggregateBoardResult {
	projects: RuntimeProjectSummary[];
	board: RuntimeAggregateBoardData | null;
	generatedAt: number | null;
	streamError: string | null;
	isRuntimeDisconnected: boolean;
	hasReceivedSnapshot: boolean;
}

export function useAggregateBoard(enabled: boolean): UseAggregateBoardResult {
	const [state, dispatch] = useReducer(aggregateBoardReducer, undefined, createInitialAggregateBoardState);

	useEffect(() => {
		if (!enabled) {
			return;
		}

		let cancelled = false;
		let socket: WebSocket | null = null;
		let reconnectTimer: number | null = null;
		let reconnectAttempt = 0;

		const cleanupSocket = () => {
			if (!socket) {
				return;
			}
			socket.onopen = null;
			socket.onmessage = null;
			socket.onerror = null;
			socket.onclose = null;
			socket.close();
			socket = null;
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
				socket = new WebSocket(getAggregateRuntimeStreamUrl());
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
					if (payload.type === "aggregate_snapshot") {
						dispatch({ type: "aggregate_snapshot", payload });
						return;
					}
					if (payload.type === "aggregate_board_updated") {
						dispatch({ type: "aggregate_board_updated", payload });
						return;
					}
					if (payload.type === "projects_updated") {
						dispatch({ type: "projects_updated", payload });
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
			if (reconnectTimer !== null) {
				window.clearTimeout(reconnectTimer);
			}
			cleanupSocket();
		};
	}, [enabled]);

	return state;
}
