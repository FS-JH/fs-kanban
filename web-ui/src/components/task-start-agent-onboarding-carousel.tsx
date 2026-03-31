import * as RadixCheckbox from "@radix-ui/react-checkbox";
import { getRuntimeAgentCatalogEntry } from "@runtime-agent-catalog";
import { Check } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import { cn } from "@/components/ui/cn";
import type { RuntimeAgentDefinition, RuntimeAgentId, RuntimeConfigResponse } from "@/runtime/types";

interface BaseOnboardingSlide {
	kind: "text" | "agent-selection";
	title: string;
	description: string;
}

interface TextOnboardingSlide extends BaseOnboardingSlide {
	kind: "text";
	accentClassName: string;
}

interface AgentSelectionSlide extends BaseOnboardingSlide {
	kind: "agent-selection";
}

type OnboardingSlide = TextOnboardingSlide | AgentSelectionSlide;

interface AgentSelectionResult {
	ok: boolean;
	message?: string;
}

interface OnboardingDoneResult {
	ok: boolean;
	message?: string;
}

export const TASK_START_ONBOARDING_SLIDES: OnboardingSlide[] = [
	{
		kind: "text",
		title: "Capture work quickly",
		description:
			"Turn ideas into backlog cards without leaving the keyboard, then move them into execution when they are ready.",
		accentClassName: "bg-accent/20 text-accent",
	},
	{
		kind: "text",
		title: "Keep work flowing",
		description:
			"Link related cards, keep the current branch visible, and promote work through the board without losing context.",
		accentClassName: "bg-status-green/20 text-status-green",
	},
	{
		kind: "text",
		title: "Review before shipping",
		description:
			"Watch diffs and terminal output side by side, then decide whether the work is ready to merge or needs another pass.",
		accentClassName: "bg-status-purple/20 text-status-purple",
	},
	{
		kind: "agent-selection",
		title: "Choose your agent",
		description: "Choose a coding agent to complete your tasks. You can change this anytime in Settings.",
	},
];

const ONBOARDING_AGENT_IDS: readonly RuntimeAgentId[] = ["claude", "codex"];
const FALLBACK_ONBOARDING_SLIDE: OnboardingSlide = {
	kind: "agent-selection",
	title: "",
	description: "",
};

function AgentStatusBadge({ label, statusClassName }: { label: string; statusClassName: string }): ReactElement {
	return (
		<span className={cn("inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium", statusClassName)}>
			{label}
		</span>
	);
}

function OnboardingFeatureCard({ slide }: { slide: TextOnboardingSlide }): ReactElement {
	return (
		<div className="rounded-xl border border-border bg-surface-1 p-4">
			<div className="flex items-center gap-2">
				<span className={cn("inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium", slide.accentClassName)}>
					{slide.title}
				</span>
				<span className="text-xs text-text-tertiary">FS Kanban</span>
			</div>
			<div className="mt-3 grid gap-3 sm:grid-cols-[1.2fr_0.8fr]">
				<div className="rounded-lg border border-border-bright bg-surface-2 p-3">
					<div className="grid gap-2">
						<div className="rounded-md bg-surface-3 px-3 py-2 text-sm text-text-primary">Backlog</div>
						<div className="rounded-md bg-accent/15 px-3 py-2 text-sm text-text-primary">In Progress</div>
						<div className="rounded-md bg-status-green/15 px-3 py-2 text-sm text-text-primary">Review</div>
					</div>
				</div>
				<div className="rounded-lg border border-border-bright bg-surface-2 p-3 text-sm text-text-secondary">
					<p className="m-0 whitespace-pre-wrap">{slide.description}</p>
				</div>
			</div>
		</div>
	);
}

function resolveInstallInstructions(agentId: RuntimeAgentId): string {
	if (agentId === "claude") {
		return "Anthropic's coding agent CLI with access to Claude models.";
	}
	if (agentId === "codex") {
		return "OpenAI's coding agent CLI with access to the latest GPT models.";
	}
	return "Install from the official docs.";
}

function getInstallLinkLabel(agentId: RuntimeAgentId): string {
	if (agentId === "claude" || agentId === "codex") {
		return "Learn more";
	}
	return "Install guide";
}

export function TaskStartAgentOnboardingCarousel({
	open: _open,
	runtimeConfig: _runtimeConfig,
	selectedAgentId,
	agents,
	activeSlideIndex,
	onSelectAgent,
	onAgentSetupSaved: _onAgentSetupSaved,
	onDoneActionChange,
}: {
	open: boolean;
	runtimeConfig: RuntimeConfigResponse | null;
	selectedAgentId: RuntimeAgentId | null;
	agents: RuntimeAgentDefinition[];
	activeSlideIndex: number;
	onSelectAgent?: (agentId: RuntimeAgentId) => Promise<AgentSelectionResult>;
	onAgentSetupSaved?: () => void;
	onDoneActionChange?: (action: (() => Promise<OnboardingDoneResult>) | null) => void;
}): ReactElement {
	const [activeAgentId, setActiveAgentId] = useState<RuntimeAgentId | null>(null);
	const [selectionError, setSelectionError] = useState<string | null>(null);
	const selectionSavePromiseRef = useRef<Promise<AgentSelectionResult> | null>(null);

	const onboardingAgents = useMemo(
		() =>
			ONBOARDING_AGENT_IDS.map((agentId) => {
				const configuredAgent = agents.find((agent) => agent.id === agentId) ?? null;
				const catalogEntry = getRuntimeAgentCatalogEntry(agentId);
				return {
					id: agentId,
					label: catalogEntry?.label ?? configuredAgent?.label ?? agentId,
					installUrl: catalogEntry?.installUrl ?? null,
					installed: configuredAgent?.installed ?? false,
				};
			}),
		[agents],
	);
	const selectableAgentIds = useMemo(() => new Set(onboardingAgents.map((agent) => agent.id)), [onboardingAgents]);
	const defaultSelectableAgentId = onboardingAgents[0]?.id ?? null;

	useEffect(() => {
		if (selectedAgentId !== null && selectableAgentIds.has(selectedAgentId)) {
			setActiveAgentId(selectedAgentId);
			return;
		}
		setActiveAgentId(defaultSelectableAgentId);
	}, [defaultSelectableAgentId, selectableAgentIds, selectedAgentId]);

	const currentSlide = TASK_START_ONBOARDING_SLIDES[activeSlideIndex] ?? FALLBACK_ONBOARDING_SLIDE;

	const handleAgentSelect = (agentId: RuntimeAgentId) => {
		if (activeAgentId === agentId) {
			return;
		}
		setActiveAgentId(agentId);
		setSelectionError(null);
		if (!onSelectAgent) {
			return;
		}
		const savePromise = onSelectAgent(agentId);
		selectionSavePromiseRef.current = savePromise;
		void savePromise
			.then((result) => {
				if (selectionSavePromiseRef.current !== savePromise) {
					return;
				}
				if (!result.ok) {
					setSelectionError(result.message ?? "Could not switch agents. Try again.");
					setActiveAgentId(selectedAgentId);
				}
			})
			.catch((error: unknown) => {
				if (selectionSavePromiseRef.current !== savePromise) {
					return;
				}
				const message = error instanceof Error ? error.message : String(error);
				setSelectionError(message || "Could not switch agents. Try again.");
				setActiveAgentId(selectedAgentId);
			})
			.finally(() => {
				if (selectionSavePromiseRef.current === savePromise) {
					selectionSavePromiseRef.current = null;
				}
			});
	};

	const handleDoneAction = useCallback(async (): Promise<OnboardingDoneResult> => {
		if (selectionSavePromiseRef.current) {
			const selectionResult = await selectionSavePromiseRef.current.catch((error: unknown) => ({
				ok: false,
				message: error instanceof Error ? error.message : String(error),
			}));
			if (!selectionResult.ok) {
				const message = selectionResult.message ?? "Could not switch agents. Try again.";
				setSelectionError(message);
				return { ok: false, message };
			}
		}
		return { ok: true };
	}, []);

	useEffect(() => {
		onDoneActionChange?.(handleDoneAction);
		return () => {
			onDoneActionChange?.(null);
		};
	}, [handleDoneAction, onDoneActionChange]);

	return (
		<div className="space-y-3">
			{currentSlide.kind === "text" ? <OnboardingFeatureCard slide={currentSlide} /> : null}

			{currentSlide.kind === "agent-selection" ? (
				<div className="space-y-2">
					{onboardingAgents.map((agent) => (
						<div
							key={agent.id}
							className={cn(
								"rounded-md border bg-surface-1 p-3",
								activeAgentId === agent.id ? "border-accent" : "border-border",
							)}
						>
							<div
								role="button"
								tabIndex={0}
								onClick={() => handleAgentSelect(agent.id)}
								onKeyDown={(event) => {
									if (event.key === "Enter" || event.key === " ") {
										event.preventDefault();
										handleAgentSelect(agent.id);
									}
								}}
								className="flex cursor-pointer items-center justify-between gap-3"
							>
								<span className="flex items-center gap-2">
									<RadixCheckbox.Root
										checked={activeAgentId === agent.id}
										onCheckedChange={(checked) => {
											if (checked === true) {
												handleAgentSelect(agent.id);
											}
										}}
										className="flex h-4 w-4 cursor-pointer items-center justify-center rounded border border-border-bright bg-surface-2 data-[state=checked]:bg-accent data-[state=checked]:border-accent"
									>
										<RadixCheckbox.Indicator>
											<Check size={12} className="text-white" />
										</RadixCheckbox.Indicator>
									</RadixCheckbox.Root>
									<span className="text-[13px] text-text-primary">{agent.label}</span>
								</span>
								{agent.installed ? (
									<AgentStatusBadge label="Detected" statusClassName="bg-status-green/10 text-status-green" />
								) : (
									<AgentStatusBadge label="Not installed" statusClassName="bg-surface-3 text-text-secondary" />
								)}
							</div>
							<p className="mt-2 mb-0 text-[12px] text-text-secondary">
								{resolveInstallInstructions(agent.id)}
								{agent.installUrl ? (
									<>
										{" "}
										<a
											href={agent.installUrl}
											target="_blank"
											rel="noreferrer"
											className="text-accent hover:underline"
										>
											{getInstallLinkLabel(agent.id)}
										</a>
									</>
								) : null}
							</p>
						</div>
					))}
					{selectionError ? (
						<div className="rounded-md border border-status-red/30 bg-status-red/5 p-2 text-[12px] text-text-primary">
							{selectionError}
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
}
