import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getRuntimeTaskSessionStatus } from "@/runtime/task-session-status";
import type { RuntimeStateStreamTaskReadyForReviewMessage, RuntimeTaskSessionSummary } from "@/runtime/types";
import { findCardSelection } from "@/state/board-state";
import type { BoardData } from "@/types";
import {
	broadcastNotificationBadgeClear,
	createNotificationBadgeSyncSourceId,
	subscribeToNotificationBadgeClear,
} from "@/utils/notification-badge-sync";
import { getBrowserNotificationPermission } from "@/utils/notification-permission";
import { playAgentAttentionSound } from "@/utils/notification-sound";
import { useDocumentTitle, useInterval, useUnmount, useWindowEvent } from "@/utils/react-use";
import {
	createTabPresenceId,
	hasVisibleKanbanTabForWorkspace,
	markTabHidden,
	markTabVisible,
} from "@/utils/tab-visibility-presence";
import { truncateTaskPromptLabel } from "@/utils/task-prompt";

interface UseReviewReadyNotificationsOptions {
	activeWorkspaceId: string | null;
	agentAttentionNotificationsEnabled: boolean;
	agentAttentionSoundEnabled: boolean;
	board: BoardData;
	isDocumentVisible: boolean;
	latestTaskReadyForReview: RuntimeStateStreamTaskReadyForReviewMessage | null;
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	readyForReviewNotificationsEnabled: boolean;
	workspacePath: string | null;
}

const MAX_HANDLED_EVENT_KEYS = 200;
const TAB_VISIBILITY_HEARTBEAT_INTERVAL_MS = 5000;

function canShowBrowserNotifications(): boolean {
	return getBrowserNotificationPermission() === "granted";
}

function isDocumentCurrentlyVisible(fallbackValue: boolean): boolean {
	if (typeof document === "undefined") {
		return fallbackValue;
	}
	return document.visibilityState === "visible";
}

function resolveTaskTitle(board: BoardData, taskId: string): string {
	const selection = findCardSelection(board, taskId);
	return selection ? truncateTaskPromptLabel(selection.card.prompt) || `Task ${taskId}` : `Task ${taskId}`;
}

function resolveReviewReadyNotificationBody(
	taskId: string,
	taskTitle: string,
	taskSessions: Record<string, RuntimeTaskSessionSummary>,
): string {
	const finalMessage = taskSessions[taskId]?.latestHookActivity?.finalMessage?.trim();
	return finalMessage || taskTitle;
}

function resolveAttentionNotificationBody(taskTitle: string, summary: RuntimeTaskSessionSummary): string {
	const status = getRuntimeTaskSessionStatus(summary);
	const finalMessage = summary.latestHookActivity?.finalMessage?.trim();
	const activityText = summary.latestHookActivity?.activityText?.trim();
	const detail = finalMessage || activityText;
	if (status.kind === "needs_approval") {
		return detail && detail !== "Waiting for approval"
			? `${taskTitle}\n${detail}`
			: `${taskTitle}\nApprove the next step to continue.`;
	}
	if (status.kind === "needs_input") {
		return detail ? `${taskTitle}\n${detail}` : `${taskTitle}\nThe agent is waiting for your answer.`;
	}
	if (status.kind === "needs_review") {
		return detail ? `${taskTitle}\n${detail}` : `${taskTitle}\nThe agent stopped and needs review.`;
	}
	return taskTitle;
}

function showBrowserNotification(tag: string, notificationTitle: string, notificationBody: string): void {
	if (!canShowBrowserNotifications()) {
		return;
	}
	try {
		const notification = new Notification(notificationTitle, {
			body: notificationBody,
			tag,
		});
		notification.onclick = () => {
			if (typeof window !== "undefined") {
				window.focus();
			}
			notification.close();
		};
	} catch {
		// Ignore browser notification failures.
	}
}

function enqueueHandledEventKey(key: string, handledKeys: Set<string>, keyQueue: string[]): void {
	handledKeys.add(key);
	keyQueue.push(key);
	if (keyQueue.length > MAX_HANDLED_EVENT_KEYS) {
		const oldestKey = keyQueue.shift();
		if (oldestKey) {
			handledKeys.delete(oldestKey);
		}
	}
}

export function useReviewReadyNotifications({
	activeWorkspaceId,
	agentAttentionNotificationsEnabled,
	agentAttentionSoundEnabled,
	board,
	isDocumentVisible,
	latestTaskReadyForReview,
	taskSessions,
	readyForReviewNotificationsEnabled,
	workspacePath,
}: UseReviewReadyNotificationsOptions): void {
	const notificationPresenceTabIdRef = useRef<string>(createTabPresenceId());
	const notificationBadgeSyncSourceIdRef = useRef<string>(createNotificationBadgeSyncSourceId());
	const handledReadyForReviewEventKeysRef = useRef<Set<string>>(new Set());
	const handledReadyForReviewEventKeyQueueRef = useRef<string[]>([]);
	const handledAttentionEventKeysRef = useRef<Set<string>>(new Set());
	const handledAttentionEventKeyQueueRef = useRef<string[]>([]);
	const previousTaskSessionsRef = useRef<Record<string, RuntimeTaskSessionSummary>>({});
	const [pendingReviewReadyNotificationCount, setPendingReviewReadyNotificationCount] = useState(0);
	const [pendingAttentionNotificationCount, setPendingAttentionNotificationCount] = useState(0);
	const [isWindowFocused, setIsWindowFocused] = useState(() => {
		if (typeof document === "undefined") {
			return true;
		}
		return document.hasFocus();
	});
	const workspaceTitle = useMemo(() => {
		if (!workspacePath) {
			return null;
		}
		const segments = workspacePath
			.replaceAll("\\", "/")
			.split("/")
			.filter((segment) => segment.length > 0);
		if (segments.length === 0) {
			return workspacePath;
		}
		return segments[segments.length - 1] ?? workspacePath;
	}, [workspacePath]);
	const isAppActive = isDocumentVisible && isWindowFocused;

	useWindowEvent("focus", () => {
		setIsWindowFocused(true);
	});
	useWindowEvent("blur", () => {
		setIsWindowFocused(false);
	});

	useEffect(() => {
		const tabId = notificationPresenceTabIdRef.current;
		const syncSourceId = notificationBadgeSyncSourceIdRef.current;
		const presenceWorkspaceId = activeWorkspaceId;
		if (isAppActive) {
			if (presenceWorkspaceId) {
				markTabVisible(tabId, presenceWorkspaceId);
			} else {
				markTabHidden(tabId);
			}
			setPendingReviewReadyNotificationCount(0);
			setPendingAttentionNotificationCount(0);
			broadcastNotificationBadgeClear(syncSourceId, presenceWorkspaceId);
		} else {
			markTabHidden(tabId);
		}
	}, [activeWorkspaceId, isAppActive]);

	useEffect(() => {
		if (activeWorkspaceId && isAppActive) {
			markTabVisible(notificationPresenceTabIdRef.current, activeWorkspaceId);
		}
	}, [activeWorkspaceId, isAppActive]);

	useInterval(
		() => {
			if (!activeWorkspaceId || !isAppActive) {
				return;
			}
			markTabVisible(notificationPresenceTabIdRef.current, activeWorkspaceId);
		},
		activeWorkspaceId && isAppActive ? TAB_VISIBILITY_HEARTBEAT_INTERVAL_MS : null,
	);

	useEffect(() => {
		if (!latestTaskReadyForReview) {
			return;
		}
		if (!activeWorkspaceId || latestTaskReadyForReview.workspaceId !== activeWorkspaceId) {
			return;
		}
		const eventKey = `${latestTaskReadyForReview.workspaceId}:${latestTaskReadyForReview.taskId}:${latestTaskReadyForReview.triggeredAt}`;
		if (handledReadyForReviewEventKeysRef.current.has(eventKey)) {
			return;
		}
		enqueueHandledEventKey(
			eventKey,
			handledReadyForReviewEventKeysRef.current,
			handledReadyForReviewEventKeyQueueRef.current,
		);
		const isVisibleNow = isDocumentCurrentlyVisible(isDocumentVisible);
		const isWindowFocusedNow = typeof document === "undefined" ? isWindowFocused : document.hasFocus();
		const hasVisiblePeerTabForWorkspace = hasVisibleKanbanTabForWorkspace(
			latestTaskReadyForReview.workspaceId,
			notificationPresenceTabIdRef.current,
		);
		if (
			!readyForReviewNotificationsEnabled ||
			(isVisibleNow && isWindowFocusedNow) ||
			hasVisiblePeerTabForWorkspace
		) {
			return;
		}
		const taskTitle = resolveTaskTitle(board, latestTaskReadyForReview.taskId);
		const notificationBody = resolveReviewReadyNotificationBody(
			latestTaskReadyForReview.taskId,
			taskTitle,
			taskSessions,
		);
		setPendingReviewReadyNotificationCount((current) => current + 1);
		const notificationTitle = workspaceTitle ? `${workspaceTitle} ready for review` : "Ready for review";
		showBrowserNotification(
			`task-ready-for-review-${latestTaskReadyForReview.taskId}`,
			notificationTitle,
			notificationBody,
		);
	}, [
		activeWorkspaceId,
		board,
		isDocumentVisible,
		isWindowFocused,
		latestTaskReadyForReview,
		readyForReviewNotificationsEnabled,
		taskSessions,
		workspaceTitle,
	]);

	useEffect(() => {
		if (!activeWorkspaceId) {
			previousTaskSessionsRef.current = taskSessions;
			return;
		}
		const isVisibleNow = isDocumentCurrentlyVisible(isDocumentVisible);
		const isWindowFocusedNow = typeof document === "undefined" ? isWindowFocused : document.hasFocus();
		const hasVisiblePeerTabForWorkspace = hasVisibleKanbanTabForWorkspace(
			activeWorkspaceId,
			notificationPresenceTabIdRef.current,
		);
		const previousTaskSessions = previousTaskSessionsRef.current;
		for (const [taskId, summary] of Object.entries(taskSessions)) {
			const previousSummary = previousTaskSessions[taskId];
			if (!previousSummary) {
				continue;
			}
			const status = getRuntimeTaskSessionStatus(summary);
			if (status.kind !== "needs_approval" && status.kind !== "needs_input" && status.kind !== "needs_review") {
				continue;
			}
			const previousStatus = getRuntimeTaskSessionStatus(previousSummary);
			const currentAttentionStamp = summary.lastHookAt ?? summary.updatedAt;
			const previousAttentionStamp = previousSummary.lastHookAt ?? previousSummary.updatedAt;
			if (previousStatus.kind === status.kind && previousAttentionStamp === currentAttentionStamp) {
				continue;
			}
			const eventKey = `${activeWorkspaceId}:${taskId}:${status.kind}:${currentAttentionStamp}`;
			if (handledAttentionEventKeysRef.current.has(eventKey)) {
				continue;
			}
			enqueueHandledEventKey(
				eventKey,
				handledAttentionEventKeysRef.current,
				handledAttentionEventKeyQueueRef.current,
			);
			if (!agentAttentionNotificationsEnabled && !agentAttentionSoundEnabled) {
				continue;
			}
			if (hasVisiblePeerTabForWorkspace && !(isVisibleNow && isWindowFocusedNow)) {
				continue;
			}
			const taskTitle = resolveTaskTitle(board, taskId);
			if (agentAttentionNotificationsEnabled && !(isVisibleNow && isWindowFocusedNow)) {
				setPendingAttentionNotificationCount((current) => current + 1);
				const notificationTitle = workspaceTitle ? `${workspaceTitle} ${status.label.toLowerCase()}` : status.label;
				showBrowserNotification(
					`task-attention-${taskId}-${status.kind}`,
					notificationTitle,
					resolveAttentionNotificationBody(taskTitle, summary),
				);
			}
			if (agentAttentionSoundEnabled) {
				playAgentAttentionSound();
			}
		}
		previousTaskSessionsRef.current = taskSessions;
	}, [
		activeWorkspaceId,
		agentAttentionNotificationsEnabled,
		agentAttentionSoundEnabled,
		board,
		isDocumentVisible,
		isWindowFocused,
		taskSessions,
		workspaceTitle,
	]);

	const handlePageHide = useCallback(() => {
		markTabHidden(notificationPresenceTabIdRef.current);
	}, []);
	useWindowEvent("pagehide", handlePageHide);
	useUnmount(() => {
		markTabHidden(notificationPresenceTabIdRef.current);
	});

	useEffect(() => {
		const syncSourceId = notificationBadgeSyncSourceIdRef.current;
		return subscribeToNotificationBadgeClear(syncSourceId, (workspaceId) => {
			if (workspaceId === activeWorkspaceId) {
				setPendingReviewReadyNotificationCount(0);
				setPendingAttentionNotificationCount(0);
			}
		});
	}, [activeWorkspaceId]);

	useEffect(() => {
		if (readyForReviewNotificationsEnabled || agentAttentionNotificationsEnabled) {
			return;
		}
		setPendingReviewReadyNotificationCount(0);
		setPendingAttentionNotificationCount(0);
		broadcastNotificationBadgeClear(notificationBadgeSyncSourceIdRef.current, activeWorkspaceId);
	}, [activeWorkspaceId, agentAttentionNotificationsEnabled, readyForReviewNotificationsEnabled]);

	useEffect(() => {
		handledReadyForReviewEventKeysRef.current.clear();
		handledReadyForReviewEventKeyQueueRef.current = [];
		handledAttentionEventKeysRef.current.clear();
		handledAttentionEventKeyQueueRef.current = [];
		previousTaskSessionsRef.current = taskSessions;
		setPendingReviewReadyNotificationCount(0);
		setPendingAttentionNotificationCount(0);
	}, [activeWorkspaceId]);

	const baseTitle = workspaceTitle || "FS Kanban";
	const totalPendingNotificationCount = pendingReviewReadyNotificationCount + pendingAttentionNotificationCount;
	const documentTitle =
		totalPendingNotificationCount > 0 ? `(${totalPendingNotificationCount}) ${baseTitle}` : baseTitle;
	useDocumentTitle(documentTitle);
}
