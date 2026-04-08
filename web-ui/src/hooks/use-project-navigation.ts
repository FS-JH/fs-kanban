import { useCallback, useEffect, useState } from "react";

import { notifyError, showAppToast } from "@/components/app-toaster";
import {
	buildAllProjectsPathname,
	buildProjectPathname,
	parseNavigationTargetFromPathname,
} from "@/hooks/app-utils";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { useRuntimeStateStream } from "@/runtime/use-runtime-state-stream";
import { useWindowEvent } from "@/utils/react-use";

const REMOVED_PROJECT_ERROR_PREFIX = "Project no longer exists on disk and was removed:";
const DIRECTORY_PICKER_UNAVAILABLE_MARKERS = [
	"could not open directory picker",
	'install "zenity" or "kdialog"',
	'install powershell ("powershell" or "pwsh")',
	'command "osascript" is not available',
] as const;
const MANUAL_PROJECT_PATH_PROMPT_MESSAGE =
	"Kanban could not open a directory picker on this runtime. Enter a project path to add:";

export function parseRemovedProjectPathFromStreamError(streamError: string | null): string | null {
	if (!streamError || !streamError.startsWith(REMOVED_PROJECT_ERROR_PREFIX)) {
		return null;
	}
	return streamError.slice(REMOVED_PROJECT_ERROR_PREFIX.length).trim();
}

export function isDirectoryPickerUnavailableErrorMessage(message: string | null | undefined): boolean {
	if (!message) {
		return false;
	}
	const normalized = message.trim().toLowerCase();
	if (!normalized) {
		return false;
	}
	return DIRECTORY_PICKER_UNAVAILABLE_MARKERS.some((marker) => normalized.includes(marker));
}

function promptForManualProjectPath(): string | null {
	if (typeof window === "undefined") {
		return null;
	}
	const rawValue = window.prompt(MANUAL_PROJECT_PATH_PROMPT_MESSAGE);
	if (rawValue === null) {
		return null;
	}
	const normalized = rawValue.trim();
	return normalized || null;
}

interface UseProjectNavigationInput {
	onProjectSwitchStart: () => void;
}

export interface UseProjectNavigationResult {
	isAggregateView: boolean;
	requestedProjectId: string | null;
	navigationCurrentProjectId: string | null;
	removingProjectId: string | null;
	pendingGitInitializationPath: string | null;
	isInitializingGitProject: boolean;
	currentProjectId: string | null;
	projects: ReturnType<typeof useRuntimeStateStream>["projects"];
	workspaceState: ReturnType<typeof useRuntimeStateStream>["workspaceState"];
	workspaceMetadata: ReturnType<typeof useRuntimeStateStream>["workspaceMetadata"];
	latestTaskReadyForReview: ReturnType<typeof useRuntimeStateStream>["latestTaskReadyForReview"];
	streamError: string | null;
	isRuntimeDisconnected: boolean;
	hasReceivedSnapshot: boolean;
	hasNoProjects: boolean;
	isProjectSwitching: boolean;
	handleSelectProject: (projectId: string) => void;
	handleSelectAllProjects: () => void;
	handleAddProject: () => Promise<void>;
	handleConfirmInitializeGitProject: () => Promise<void>;
	handleCancelInitializeGitProject: () => void;
	handleRemoveProject: (projectId: string) => Promise<boolean>;
	resetProjectNavigationState: () => void;
}

export function useProjectNavigation({ onProjectSwitchStart }: UseProjectNavigationInput): UseProjectNavigationResult {
	const [routeState, setRouteState] = useState(() => {
		if (typeof window === "undefined") {
			return {
				isAggregateView: false,
				requestedProjectId: null,
			};
		}
		const target = parseNavigationTargetFromPathname(window.location.pathname);
		return {
			isAggregateView: target.kind === "all-projects",
			requestedProjectId: target.kind === "project" ? target.projectId : null,
		};
	});
	const [pendingAddedProjectId, setPendingAddedProjectId] = useState<string | null>(null);
	const [removingProjectId, setRemovingProjectId] = useState<string | null>(null);
	const [pendingGitInitializationPath, setPendingGitInitializationPath] = useState<string | null>(null);
	const [isInitializingGitProject, setIsInitializingGitProject] = useState(false);
	const requestedProjectId = routeState.requestedProjectId;
	const isAggregateView = routeState.isAggregateView;

	const {
		currentProjectId,
		projects,
		workspaceState,
		workspaceMetadata,
		latestTaskReadyForReview,
		streamError,
		isRuntimeDisconnected,
		hasReceivedSnapshot,
	} = useRuntimeStateStream(requestedProjectId);

	const hasNoProjects = hasReceivedSnapshot && projects.length === 0 && currentProjectId === null;
	const isProjectSwitching =
		!isAggregateView && requestedProjectId !== null && requestedProjectId !== currentProjectId && !hasNoProjects;
	const navigationCurrentProjectId = isAggregateView ? null : requestedProjectId ?? currentProjectId;

	const handleSelectProject = useCallback(
		(projectId: string) => {
			if (!projectId || (!isAggregateView && projectId === currentProjectId)) {
				return;
			}
			onProjectSwitchStart();
			setRouteState({
				isAggregateView: false,
				requestedProjectId: projectId,
			});
		},
		[currentProjectId, isAggregateView, onProjectSwitchStart],
	);

	const handleSelectAllProjects = useCallback(() => {
		onProjectSwitchStart();
		setRouteState({
			isAggregateView: true,
			requestedProjectId: null,
		});
	}, [onProjectSwitchStart]);

	const addProjectByPath = useCallback(
		async (path: string, initializeGit = false) => {
			const trpcClient = getRuntimeTrpcClient(currentProjectId);
			const added = await trpcClient.projects.add.mutate({
				path,
				initializeGit,
			});
			if (!added.ok || !added.project) {
				if (added.requiresGitInitialization) {
					setPendingGitInitializationPath(path);
					return;
				}
				throw new Error(added.error ?? "Could not add project.");
			}
			setPendingGitInitializationPath(null);
			setPendingAddedProjectId(added.project.id);
			handleSelectProject(added.project.id);
		},
		[currentProjectId, handleSelectProject],
	);

	const handleAddProject = useCallback(async () => {
		try {
			const trpcClient = getRuntimeTrpcClient(currentProjectId);
			const picked = await trpcClient.projects.pickDirectory.mutate();

			let projectPath: string | null = null;
			if (picked.ok && picked.path) {
				projectPath = picked.path;
			} else if (!picked.ok && picked.error === "No directory was selected.") {
				return;
			} else if (!picked.ok && isDirectoryPickerUnavailableErrorMessage(picked.error)) {
				showAppToast({
					intent: "warning",
					icon: "warning-sign",
					message: "Directory picker unavailable on this runtime. Enter the project path manually.",
					timeout: 5000,
				});
				projectPath = promptForManualProjectPath();
				if (!projectPath) {
					return;
				}
			} else {
				throw new Error(picked.error ?? "Could not pick project directory.");
			}
			if (!projectPath) {
				return;
			}
			await addProjectByPath(projectPath);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			showAppToast({
				intent: "danger",
				icon: "warning-sign",
				message,
				timeout: 7000,
			});
		}
	}, [addProjectByPath, currentProjectId]);

	const handleConfirmInitializeGitProject = useCallback(async () => {
		if (!pendingGitInitializationPath || isInitializingGitProject) {
			return;
		}
		setIsInitializingGitProject(true);
		try {
			await addProjectByPath(pendingGitInitializationPath, true);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			showAppToast({
				intent: "danger",
				icon: "warning-sign",
				message,
				timeout: 7000,
			});
		} finally {
			setIsInitializingGitProject(false);
		}
	}, [addProjectByPath, isInitializingGitProject, pendingGitInitializationPath]);

	const handleCancelInitializeGitProject = useCallback(() => {
		if (isInitializingGitProject) {
			return;
		}
		setPendingGitInitializationPath(null);
	}, [isInitializingGitProject]);

	const handleRemoveProject = useCallback(
		async (projectId: string): Promise<boolean> => {
			if (removingProjectId) {
				return false;
			}
			setRemovingProjectId(projectId);
			try {
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				const payload = await trpcClient.projects.remove.mutate({ projectId });
				if (!payload.ok) {
					throw new Error(payload.error ?? "Could not remove project.");
				}
				if (currentProjectId === projectId) {
					onProjectSwitchStart();
					setRouteState((current) => ({
						...current,
						requestedProjectId: null,
					}));
				}
				return true;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notifyError(message);
				return false;
			} finally {
				setRemovingProjectId((current) => (current === projectId ? null : current));
			}
		},
		[currentProjectId, onProjectSwitchStart, removingProjectId],
	);

	const handlePopState = useCallback(() => {
		if (typeof window === "undefined") {
			return;
		}
		const target = parseNavigationTargetFromPathname(window.location.pathname);
		setRouteState({
			isAggregateView: target.kind === "all-projects",
			requestedProjectId: target.kind === "project" ? target.projectId : null,
		});
	}, []);
	useWindowEvent("popstate", handlePopState);

	useEffect(() => {
		if (typeof window === "undefined") {
			return;
		}
		if (isAggregateView) {
			const nextUrl = new URL(window.location.href);
			const nextPathname = buildAllProjectsPathname();
			if (nextUrl.pathname === nextPathname) {
				return;
			}
			window.history.replaceState({}, "", `${nextPathname}${nextUrl.search}${nextUrl.hash}`);
			return;
		}
		if (!currentProjectId) {
			return;
		}
		const nextUrl = new URL(window.location.href);
		const nextPathname = buildProjectPathname(currentProjectId);
		if (nextUrl.pathname === nextPathname) {
			return;
		}
		window.history.replaceState({}, "", `${nextPathname}${nextUrl.search}${nextUrl.hash}`);
	}, [currentProjectId, isAggregateView]);

	useEffect(() => {
		if (typeof window === "undefined") {
			return;
		}
		if (!hasNoProjects || !requestedProjectId) {
			return;
		}
		const nextUrl = new URL(window.location.href);
		if (nextUrl.pathname !== "/") {
			window.history.replaceState({}, "", `/${nextUrl.search}${nextUrl.hash}`);
		}
		setRouteState({
			isAggregateView: false,
			requestedProjectId: null,
		});
	}, [hasNoProjects, requestedProjectId]);

	useEffect(() => {
		if (!pendingAddedProjectId) {
			return;
		}
		const projectExists = projects.some((project) => project.id === pendingAddedProjectId);
		if (!projectExists && currentProjectId !== pendingAddedProjectId) {
			return;
		}
		setPendingAddedProjectId(null);
	}, [currentProjectId, pendingAddedProjectId, projects]);

	useEffect(() => {
		if (!requestedProjectId || !currentProjectId) {
			return;
		}
		if (pendingAddedProjectId && requestedProjectId === pendingAddedProjectId) {
			return;
		}
		const requestedStillExists = projects.some((project) => project.id === requestedProjectId);
		if (requestedStillExists) {
			return;
		}
		setRouteState((current) => ({
			...current,
			requestedProjectId: currentProjectId,
		}));
	}, [currentProjectId, pendingAddedProjectId, projects, requestedProjectId]);

	const resetProjectNavigationState = useCallback(() => {
		setRemovingProjectId(null);
		setPendingGitInitializationPath(null);
		setIsInitializingGitProject(false);
	}, []);

	return {
		isAggregateView,
		requestedProjectId,
		navigationCurrentProjectId,
		removingProjectId,
		pendingGitInitializationPath,
		isInitializingGitProject,
		currentProjectId,
		projects,
		workspaceState,
		workspaceMetadata,
		latestTaskReadyForReview,
		streamError,
		isRuntimeDisconnected,
		hasReceivedSnapshot,
		hasNoProjects,
		isProjectSwitching,
		handleSelectProject,
		handleSelectAllProjects,
		handleAddProject,
		handleConfirmInitializeGitProject,
		handleCancelInitializeGitProject,
		handleRemoveProject,
		resetProjectNavigationState,
	};
}
