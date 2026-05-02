import { act, useCallback, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHomeAgentSessionId } from "@runtime-home-agent-session";

import { useHomeAgentSession } from "@/hooks/use-home-agent-session";
import type { RuntimeConfigResponse, RuntimeGitRepositoryInfo, RuntimeTaskSessionSummary } from "@/runtime/types";

const startTaskSessionMutateMock = vi.hoisted(() => vi.fn());
const stopTaskSessionMutateMock = vi.hoisted(() => vi.fn());
const notifyErrorMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: (workspaceId: string | null) => ({
		runtime: {
			startTaskSession: {
				mutate: (input: object) => startTaskSessionMutateMock({ workspaceId, ...input }),
			},
			stopTaskSession: {
				mutate: (input: object) => stopTaskSessionMutateMock({ workspaceId, ...input }),
			},
		},
	}),
}));

vi.mock("@/runtime/task-session-geometry", () => ({
	estimateTaskSessionGeometry: () => ({ cols: 120, rows: 24 }),
}));

vi.mock("@/components/app-toaster", () => ({
	notifyError: notifyErrorMock,
}));

interface HookSnapshot {
	sessionKeys: string[];
	taskId: string | null;
}

type SummaryState = RuntimeTaskSessionSummary["state"];
type SummaryAgentId = NonNullable<RuntimeTaskSessionSummary["agentId"]>;

function expectHookSnapshot(snapshot: HookSnapshot | null): HookSnapshot {
	if (!snapshot) {
		throw new Error("Expected a home agent snapshot.");
	}
	return snapshot;
}

function createSummary(
	taskId: string,
	agentId: SummaryAgentId,
	state: SummaryState = "running",
	overrides: Partial<RuntimeTaskSessionSummary> = {},
): RuntimeTaskSessionSummary {
	return {
		taskId,
		state,
		mode: "act",
		agentId,
		workspacePath: "/tmp/repo",
		pid: state === "running" || state === "awaiting_review" ? 1234 : null,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: Date.now(),
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...overrides,
	};
}

function resolveHomeAgentId(taskId: string): SummaryAgentId {
	const agentId = taskId.split(":").pop();
	if (agentId === "claude" || agentId === "codex") {
		return agentId;
	}
	throw new Error(`Expected home agent task id to end with an agent id: ${taskId}`);
}

function createRuntimeConfig(overrides: Partial<RuntimeConfigResponse> = {}): RuntimeConfigResponse {
	const base: RuntimeConfigResponse = {
		selectedAgentId: "codex",
		fallbackAgentId: null,
		selectedShortcutLabel: null,
		agentApprovalMode: "full_auto",
		agentAutonomousModeEnabled: true,
		effectiveCommand: "codex --dangerously-bypass-approvals-and-sandbox",
		globalConfigPath: "/tmp/global-config.json",
		projectConfigPath: "/tmp/project-config.json",
		readyForReviewNotificationsEnabled: true,
		detectedCommands: ["codex", "claude"],
		agents: [
			{
				id: "codex",
				label: "OpenAI Codex",
				binary: "codex",
				command: "codex --dangerously-bypass-approvals-and-sandbox",
				defaultArgs: [],
				installed: true,
				configured: true,
			},
			{
				id: "claude",
				label: "Claude Code",
				binary: "claude",
				command: "claude --dangerously-skip-permissions",
				defaultArgs: [],
				installed: true,
				configured: false,
			},
		],
		shortcuts: [],
		commitPromptTemplate: "commit",
		openPrPromptTemplate: "pr",
		commitPromptTemplateDefault: "commit",
		openPrPromptTemplateDefault: "pr",
	};
	const merged = { ...base, ...overrides };
	const agentApprovalMode = merged.agentApprovalMode;
	return {
		...merged,
		agentApprovalMode,
		agentAutonomousModeEnabled: agentApprovalMode === "full_auto",
	};
}

const DEFAULT_WORKSPACE_GIT: RuntimeGitRepositoryInfo = {
	currentBranch: "main",
	defaultBranch: "main",
	branches: ["main"],
};

function HookHarness({
	config,
	currentProjectId,
	onSnapshot,
	workspaceGit = DEFAULT_WORKSPACE_GIT,
	initialSessionSummaries = {},
	sessionSummariesOverride,
}: {
	config: RuntimeConfigResponse | null;
	currentProjectId: string | null;
	onSnapshot: (snapshot: HookSnapshot) => void;
	workspaceGit?: RuntimeGitRepositoryInfo | null;
	initialSessionSummaries?: Record<string, RuntimeTaskSessionSummary>;
	sessionSummariesOverride?: Record<string, RuntimeTaskSessionSummary>;
}): null {
	const [sessionSummaries, setSessionSummaries] =
		useState<Record<string, RuntimeTaskSessionSummary>>(initialSessionSummaries);
	useEffect(() => {
		if (sessionSummariesOverride) {
			setSessionSummaries(sessionSummariesOverride);
		}
	}, [sessionSummariesOverride]);
	const upsertSessionSummary = useCallback((summary: RuntimeTaskSessionSummary) => {
		setSessionSummaries((currentSessions) => ({
			...currentSessions,
			[summary.taskId]: summary,
		}));
	}, []);
	const result = useHomeAgentSession({
		currentProjectId,
		runtimeProjectConfig: config,
		workspaceGit,
		sessionSummaries,
		setSessionSummaries,
		upsertSessionSummary,
	});

	useEffect(() => {
		onSnapshot({
			sessionKeys: Object.keys(sessionSummaries),
			taskId: result.taskId,
		});
	}, [onSnapshot, result.taskId, sessionSummaries]);

	return null;
}

describe("useHomeAgentSession", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		startTaskSessionMutateMock.mockReset();
		stopTaskSessionMutateMock.mockReset();
		startTaskSessionMutateMock.mockImplementation(
			async ({ taskId }: { taskId: string }) => ({
				ok: true,
				summary: createSummary(taskId, resolveHomeAgentId(taskId)),
			}),
		);
		notifyErrorMock.mockReset();
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("starts a home terminal session for the selected local agent", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					config={createRuntimeConfig()}
					currentProjectId="workspace-1"
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await Promise.resolve();
			await Promise.resolve();
		});

		const snapshot = expectHookSnapshot(latestSnapshot);
		expect(snapshot.taskId).toBe(createHomeAgentSessionId("workspace-1", "codex"));
		expect(startTaskSessionMutateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				workspaceId: "workspace-1",
				taskId: snapshot.taskId,
				baseRef: "main",
			}),
		);
	});

	it.each(["interrupted", "failed", "idle"] satisfies SummaryState[])(
		"starts a fresh home terminal session when the existing summary is %s",
		async (existingState) => {
			const taskId = createHomeAgentSessionId("workspace-1", "codex");
			let latestSnapshot: HookSnapshot | null = null;

			await act(async () => {
				root.render(
					<HookHarness
						config={createRuntimeConfig()}
						currentProjectId="workspace-1"
						initialSessionSummaries={{
							[taskId]: createSummary(taskId, "codex", existingState),
						}}
						onSnapshot={(snapshot) => {
							latestSnapshot = snapshot;
						}}
					/>,
				);
				await Promise.resolve();
				await Promise.resolve();
			});

			const snapshot = expectHookSnapshot(latestSnapshot);
			expect(snapshot.taskId).toBe(taskId);
			expect(startTaskSessionMutateMock).toHaveBeenCalledWith(
				expect.objectContaining({
					workspaceId: "workspace-1",
					taskId,
					baseRef: "main",
				}),
			);
		},
	);

	it.each(["running", "awaiting_review"] satisfies SummaryState[])(
		"does not start a duplicate home terminal session when the existing summary is %s",
		async (existingState) => {
			const taskId = createHomeAgentSessionId("workspace-1", "codex");
			let latestSnapshot: HookSnapshot | null = null;

			await act(async () => {
				root.render(
					<HookHarness
						config={createRuntimeConfig()}
						currentProjectId="workspace-1"
						initialSessionSummaries={{
							[taskId]: createSummary(taskId, "codex", existingState),
						}}
						onSnapshot={(snapshot) => {
							latestSnapshot = snapshot;
						}}
					/>,
				);
				await Promise.resolve();
				await Promise.resolve();
			});

			const snapshot = expectHookSnapshot(latestSnapshot);
			expect(snapshot.taskId).toBe(taskId);
			expect(startTaskSessionMutateMock).not.toHaveBeenCalled();
		},
	);

	it("starts a fresh home terminal session when an awaiting-review summary has no live process", async () => {
		const taskId = createHomeAgentSessionId("workspace-1", "codex");
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					config={createRuntimeConfig()}
					currentProjectId="workspace-1"
					initialSessionSummaries={{
						[taskId]: createSummary(taskId, "codex", "awaiting_review", {
							pid: null,
							reviewReason: "exit",
							exitCode: 0,
						}),
					}}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await Promise.resolve();
			await Promise.resolve();
		});

		const snapshot = expectHookSnapshot(latestSnapshot);
		expect(snapshot.taskId).toBe(taskId);
		expect(startTaskSessionMutateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				workspaceId: "workspace-1",
				taskId,
				baseRef: "main",
			}),
		);
	});

	it("starts a fresh home terminal session after an active summary exits in the same mount", async () => {
		const taskId = createHomeAgentSessionId("workspace-1", "codex");
		let latestSnapshot: HookSnapshot | null = null;
		const activeSummary = createSummary(taskId, "codex", "awaiting_review");
		const exitedSummary = createSummary(taskId, "codex", "awaiting_review", {
			pid: null,
			reviewReason: "exit",
			exitCode: 0,
			updatedAt: activeSummary.updatedAt + 1,
		});

		await act(async () => {
			root.render(
				<HookHarness
					config={createRuntimeConfig()}
					currentProjectId="workspace-1"
					initialSessionSummaries={{
						[taskId]: activeSummary,
					}}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(startTaskSessionMutateMock).not.toHaveBeenCalled();

		await act(async () => {
			root.render(
				<HookHarness
					config={createRuntimeConfig()}
					currentProjectId="workspace-1"
					initialSessionSummaries={{
						[taskId]: activeSummary,
					}}
					sessionSummariesOverride={{
						[taskId]: exitedSummary,
					}}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		const snapshot = expectHookSnapshot(latestSnapshot);
		expect(snapshot.taskId).toBe(taskId);
		expect(startTaskSessionMutateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				workspaceId: "workspace-1",
				taskId,
				baseRef: "main",
			}),
		);
	});

	it("rotates the home session id and stops the previous session when the selected agent changes", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					config={createRuntimeConfig()}
					currentProjectId="workspace-1"
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await Promise.resolve();
			await Promise.resolve();
		});

		const firstSnapshot = expectHookSnapshot(latestSnapshot);
		const firstTaskId = firstSnapshot.taskId;
		if (!firstTaskId) {
			throw new Error("Expected the first home task id.");
		}

		await act(async () => {
			root.render(
				<HookHarness
					config={createRuntimeConfig({
						selectedAgentId: "claude",
						effectiveCommand: "claude --dangerously-skip-permissions",
						agents: [
							{
								id: "codex",
								label: "OpenAI Codex",
								binary: "codex",
								command: "codex --dangerously-bypass-approvals-and-sandbox",
								defaultArgs: [],
								installed: true,
								configured: false,
							},
							{
								id: "claude",
								label: "Claude Code",
								binary: "claude",
								command: "claude --dangerously-skip-permissions",
								defaultArgs: [],
								installed: true,
								configured: true,
							},
						],
					})}
					currentProjectId="workspace-1"
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await Promise.resolve();
			await Promise.resolve();
		});

		const secondSnapshot = expectHookSnapshot(latestSnapshot);
		expect(secondSnapshot.taskId).toBe(createHomeAgentSessionId("workspace-1", "claude"));
		expect(secondSnapshot.taskId).not.toBe(firstTaskId);
		expect(stopTaskSessionMutateMock).toHaveBeenCalledWith({
			workspaceId: "workspace-1",
			taskId: firstTaskId,
		});
	});
});
