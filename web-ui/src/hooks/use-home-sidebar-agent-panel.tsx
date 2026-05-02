// Composes the sidebar agent surface for the current workspace.
// The home agent is always rendered as a terminal-backed local CLI session.
import type { ReactElement } from "react";
import { useCallback, useMemo, useState } from "react";
import { RotateCcw } from "lucide-react";

import { AgentTerminalPanel } from "@/components/detail-panels/agent-terminal-panel";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { selectNewestTaskSessionSummary } from "@/hooks/home-sidebar-agent-panel-session-summary";
import { useHomeAgentSession } from "@/hooks/use-home-agent-session";
import { getRuntimeTaskSessionStatus, type RuntimeTaskSessionTone } from "@/runtime/task-session-status";
import type { RuntimeConfigResponse, RuntimeGitRepositoryInfo, RuntimeTaskSessionSummary } from "@/runtime/types";
import { TERMINAL_THEME_COLORS } from "@/terminal/theme-colors";

interface UseHomeSidebarAgentPanelInput {
	currentProjectId: string | null;
	hasNoProjects: boolean;
	runtimeProjectConfig: RuntimeConfigResponse | null;
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	workspaceGit: RuntimeGitRepositoryInfo | null;
}

interface UseHomeSidebarAgentPanelResult {
	panel: ReactElement | null;
	summary: RuntimeTaskSessionSummary | null;
	taskId: string | null;
	restartSession: () => Promise<void>;
}

const STATUS_DOT_CLASS: Record<RuntimeTaskSessionTone, string> = {
	neutral: "bg-text-tertiary",
	info: "bg-status-blue",
	success: "bg-status-green",
	warning: "bg-status-orange",
	danger: "bg-status-red",
};

export function useHomeSidebarAgentPanel({
	currentProjectId,
	hasNoProjects,
	runtimeProjectConfig,
	taskSessions,
	workspaceGit,
}: UseHomeSidebarAgentPanelInput): UseHomeSidebarAgentPanelResult {
	const [sessionSummaries, setSessionSummaries] = useState<Record<string, RuntimeTaskSessionSummary>>({});
	const upsertSessionSummary = useCallback((summary: RuntimeTaskSessionSummary) => {
		setSessionSummaries((currentSessions) => {
			const previousSummary = currentSessions[summary.taskId] ?? null;
			const newestSummary = selectNewestTaskSessionSummary(previousSummary, summary);
			if (newestSummary !== summary) {
				return currentSessions;
			}
			return {
				...currentSessions,
				[summary.taskId]: newestSummary,
			};
		});
	}, []);

	const effectiveSessionSummaries = useMemo(() => {
		const mergedSessionSummaries = { ...taskSessions };
		for (const [taskId, summary] of Object.entries(sessionSummaries)) {
			const newestSummary = selectNewestTaskSessionSummary(mergedSessionSummaries[taskId] ?? null, summary);
			if (newestSummary) {
				mergedSessionSummaries[taskId] = newestSummary;
			}
		}
		return mergedSessionSummaries;
	}, [sessionSummaries, taskSessions]);

	const { taskId, restartSession } = useHomeAgentSession({
		currentProjectId,
		runtimeProjectConfig,
		workspaceGit,
		sessionSummaries: effectiveSessionSummaries,
		setSessionSummaries,
		upsertSessionSummary,
	});

	const selectedAgentLabel = useMemo(() => {
		if (!runtimeProjectConfig) {
			return "selected agent";
		}
		return (
			runtimeProjectConfig.agents.find((agent) => agent.id === runtimeProjectConfig.selectedAgentId)?.label ??
			"selected agent"
		);
	}, [runtimeProjectConfig]);

	const homeAgentPanelSummary = taskId ? (effectiveSessionSummaries[taskId] ?? null) : null;
	const homeAgentStatus = getRuntimeTaskSessionStatus(homeAgentPanelSummary);

	if (hasNoProjects || !currentProjectId) {
		return {
			panel: null,
			summary: null,
			taskId: null,
			restartSession,
		};
	}

	if (!runtimeProjectConfig) {
		return {
			panel: (
				<div className="flex w-full items-center justify-center rounded-md border border-border bg-surface-2 px-3 py-6">
					<Spinner size={20} />
				</div>
			),
			summary: null,
			taskId: null,
			restartSession,
		};
	}

	if (taskId) {
		return {
			panel: (
				<div className="flex min-h-0 w-full flex-col overflow-hidden rounded-md border border-border bg-surface-2">
					<div className="flex items-center justify-between gap-2 border-b border-border px-2 py-1.5">
						<div className="flex min-w-0 items-center gap-2">
							<span
								className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT_CLASS[homeAgentStatus.tone]}`}
								aria-hidden
							/>
							<span className="truncate text-xs font-medium text-text-primary">{homeAgentStatus.label}</span>
						</div>
						<Button
							icon={<RotateCcw size={13} />}
							variant="ghost"
							size="sm"
							onClick={() => {
								void restartSession();
							}}
							aria-label="Restart board agent"
							className="shrink-0"
						/>
					</div>
					<div className="flex min-h-0 flex-1">
						<AgentTerminalPanel
							key={taskId}
							taskId={taskId}
							workspaceId={currentProjectId}
							summary={homeAgentPanelSummary}
							onSummary={upsertSessionSummary}
							showSessionToolbar={false}
							autoFocus
							panelBackgroundColor={TERMINAL_THEME_COLORS.surfaceRaised}
							terminalBackgroundColor={TERMINAL_THEME_COLORS.surfaceRaised}
							cursorColor={TERMINAL_THEME_COLORS.textPrimary}
							showRightBorder={false}
							onRestart={() => {
								void restartSession();
							}}
						/>
					</div>
				</div>
			),
			summary: homeAgentPanelSummary,
			taskId,
			restartSession,
		};
	}

	return {
		panel: (
			<div className="flex w-full items-center justify-center rounded-md border border-border bg-surface-2 px-3 text-center text-sm text-text-secondary">
				No runnable {selectedAgentLabel} command is configured. Open Settings, install the CLI, and select it.
			</div>
		),
		summary: null,
		taskId: null,
		restartSession,
	};
}
