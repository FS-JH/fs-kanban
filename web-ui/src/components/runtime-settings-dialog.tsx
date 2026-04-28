// Settings dialog composition for FS Kanban.
// Generic app settings live here, while agent-specific launch details stay in
// focused runtime helpers instead of accumulating in the dialog.
import * as RadixPopover from "@radix-ui/react-popover";
import * as RadixSwitch from "@radix-ui/react-switch";
import { getRuntimeAgentCatalogEntry, getRuntimeLaunchSupportedAgentCatalog } from "@runtime-agent-catalog";
import { areRuntimeProjectShortcutsEqual } from "@runtime-shortcuts";
import { ChevronDown, Circle, CircleDot, ExternalLink, Plus, Settings, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	getRuntimeShortcutIconComponent,
	getRuntimeShortcutPickerOption,
	RUNTIME_SHORTCUT_ICON_OPTIONS,
	type RuntimeShortcutIconOption,
	type RuntimeShortcutPickerIconId,
} from "@/components/shared/runtime-shortcut-icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { TASK_GIT_BASE_REF_PROMPT_VARIABLE, type TaskGitAction } from "@/git-actions/build-task-git-action-prompt";
import { openFileOnHost } from "@/runtime/runtime-config-query";
import type {
	RuntimeAgentApprovalMode,
	RuntimeAgentId,
	RuntimeConfigResponse,
	RuntimeProjectShortcut,
} from "@/runtime/types";
import { useRuntimeConfig } from "@/runtime/use-runtime-config";
import {
	type BrowserNotificationPermission,
	getBrowserNotificationPermission,
	requestBrowserNotificationPermission,
} from "@/utils/notification-permission";
import { formatPathForDisplay } from "@/utils/path-display";
import { useUnmount, useWindowEvent } from "@/utils/react-use";

interface RuntimeSettingsAgentRowModel {
	id: RuntimeAgentId;
	label: string;
	binary: string;
	command: string;
	installed: boolean | null;
}

function quoteCommandPartForDisplay(part: string): string {
	if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(part)) {
		return part;
	}
	return JSON.stringify(part);
}

function buildDisplayedAgentCommand(
	agentId: RuntimeAgentId,
	binary: string,
	approvalMode: RuntimeAgentApprovalMode,
): string {
	const args = approvalMode === "full_auto" ? (getRuntimeAgentCatalogEntry(agentId)?.autonomousArgs ?? []) : [];
	return [binary, ...args.map(quoteCommandPartForDisplay)].join(" ");
}

function renderSwitch({
	checked,
	disabled,
	onCheckedChange,
}: {
	checked: boolean;
	disabled: boolean;
	onCheckedChange: (checked: boolean) => void;
}): React.ReactElement {
	return (
		<RadixSwitch.Root
			checked={checked}
			disabled={disabled}
			onCheckedChange={onCheckedChange}
			className="relative h-5 w-9 rounded-full bg-surface-4 data-[state=checked]:bg-accent cursor-pointer disabled:opacity-40"
		>
			<RadixSwitch.Thumb className="block h-4 w-4 rounded-full bg-white shadow-sm transition-transform translate-x-0.5 data-[state=checked]:translate-x-[18px]" />
		</RadixSwitch.Root>
	);
}

function normalizeTemplateForComparison(value: string): string {
	return value.replaceAll("\r\n", "\n").trim();
}

const GIT_PROMPT_VARIANT_OPTIONS: Array<{ value: TaskGitAction; label: string }> = [
	{ value: "commit", label: "Commit" },
	{ value: "pr", label: "Make PR" },
];

export type RuntimeSettingsSection = "shortcuts";

const SETTINGS_AGENT_ORDER: readonly RuntimeAgentId[] = ["codex", "claude"];
const AGENT_APPROVAL_MODE_OPTIONS: Array<{
	value: RuntimeAgentApprovalMode;
	label: string;
	description: string;
}> = [
	{
		value: "manual",
		label: "Manual",
		description: "Stop on every permission prompt and wait for you.",
	},
	{
		value: "supervised",
		label: "Supervised",
		description: "Auto-approve only clearly safe read-only steps. Risky or ambiguous prompts still stop.",
	},
	{
		value: "full_auto",
		label: "Full auto",
		description: "Pass the CLI bypass flags and skip permission prompts entirely.",
	},
];

function resolveAgentApprovalMode(config: RuntimeConfigResponse | null | undefined): RuntimeAgentApprovalMode {
	if (config?.agentApprovalMode) {
		return config.agentApprovalMode;
	}
	return config?.agentAutonomousModeEnabled === false ? "manual" : "full_auto";
}

function getShortcutIconOption(icon: string | undefined): RuntimeShortcutIconOption {
	return getRuntimeShortcutPickerOption(icon);
}

function ShortcutIconComponent({ icon, size = 14 }: { icon: string | undefined; size?: number }): React.ReactElement {
	const Component = getRuntimeShortcutIconComponent(icon);
	return <Component size={size} />;
}

function formatNotificationPermissionStatus(permission: BrowserNotificationPermission): string {
	if (permission === "default") {
		return "not requested yet";
	}
	return permission;
}

function getNextShortcutLabel(shortcuts: RuntimeProjectShortcut[], baseLabel: string): string {
	const normalizedTakenLabels = new Set(
		shortcuts.map((shortcut) => shortcut.label.trim().toLowerCase()).filter((label) => label.length > 0),
	);
	const normalizedBaseLabel = baseLabel.trim().toLowerCase();
	if (!normalizedTakenLabels.has(normalizedBaseLabel)) {
		return baseLabel;
	}

	let suffix = 2;
	while (normalizedTakenLabels.has(`${normalizedBaseLabel} ${suffix}`)) {
		suffix += 1;
	}
	return `${baseLabel} ${suffix}`;
}

function AgentRow({
	agent,
	isSelected,
	onSelect,
	disabled,
}: {
	agent: RuntimeSettingsAgentRowModel;
	isSelected: boolean;
	onSelect: () => void;
	disabled: boolean;
}): React.ReactElement {
	const installUrl = getRuntimeAgentCatalogEntry(agent.id)?.installUrl;
	const isInstalled = agent.installed === true;
	const isInstallStatusPending = agent.installed === null;

	return (
		<div
			role="button"
			tabIndex={0}
			onClick={() => {
				if (isInstalled && !disabled) {
					onSelect();
				}
			}}
			onKeyDown={(event) => {
				if (event.key === "Enter" && isInstalled && !disabled) {
					onSelect();
				}
			}}
			className="flex items-center justify-between gap-3 py-1.5"
			style={{ cursor: isInstalled ? "pointer" : "default" }}
		>
			<div className="flex items-start gap-2 min-w-0">
				{isSelected ? (
					<CircleDot size={16} className="text-accent mt-0.5 shrink-0" />
				) : (
					<Circle
						size={16}
						className={cn("mt-0.5 shrink-0", !isInstalled ? "text-text-tertiary" : "text-text-secondary")}
					/>
				)}
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<span className="text-[13px] text-text-primary">{agent.label}</span>
						{isInstalled ? (
							<span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-status-green/10 text-status-green">
								Installed
							</span>
						) : isInstallStatusPending ? (
							<span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-surface-3 text-text-secondary">
								Checking...
							</span>
						) : null}
					</div>
					{agent.command ? (
						<p className="text-text-secondary font-mono text-xs mt-0.5 m-0">{agent.command}</p>
					) : null}
				</div>
			</div>
			{agent.installed === false && installUrl ? (
				<a
					href={installUrl}
					target="_blank"
					rel="noreferrer"
					onClick={(event: React.MouseEvent) => event.stopPropagation()}
					className="inline-flex items-center justify-center rounded-md font-medium duration-150 cursor-default select-none h-7 px-2 text-xs bg-surface-2 border border-border text-text-primary hover:bg-surface-3 hover:border-border-bright"
				>
					Install
				</a>
			) : agent.installed === false ? (
				<Button size="sm" disabled>
					Install
				</Button>
			) : null}
		</div>
	);
}

function InlineUtilityButton({
	text,
	onClick,
	disabled,
	monospace,
	widthCh,
}: {
	text: string;
	onClick: () => void;
	disabled?: boolean;
	monospace?: boolean;
	widthCh?: number;
}): React.ReactElement {
	return (
		<Button
			size="sm"
			disabled={disabled}
			onClick={onClick}
			className={cn(monospace && "font-mono")}
			style={{
				fontSize: 10,
				verticalAlign: "middle",
				...(typeof widthCh === "number"
					? {
							width: `${widthCh}ch`,
							justifyContent: "center",
						}
					: {}),
			}}
		>
			{text}
		</Button>
	);
}

function ShortcutIconPicker({
	value,
	onSelect,
}: {
	value: string | undefined;
	onSelect: (icon: RuntimeShortcutPickerIconId) => void;
}): React.ReactElement {
	const [open, setOpen] = useState(false);
	const selectedOption = getShortcutIconOption(value);

	return (
		<RadixPopover.Root open={open} onOpenChange={setOpen}>
			<RadixPopover.Trigger asChild>
				<button
					type="button"
					aria-label={`Shortcut icon: ${selectedOption.label}`}
					className="inline-flex items-center gap-1 h-7 px-1.5 rounded-md border border-border bg-surface-2 text-text-primary hover:bg-surface-3"
				>
					<ShortcutIconComponent icon={value} size={14} />
					<ChevronDown size={12} />
				</button>
			</RadixPopover.Trigger>
			<RadixPopover.Portal>
				<RadixPopover.Content
					side="bottom"
					align="start"
					sideOffset={4}
					className="z-50 rounded-md border border-border bg-surface-2 p-1 shadow-lg"
					style={{ animation: "kb-tooltip-show 100ms ease" }}
				>
					<div className="flex gap-0.5">
						{RUNTIME_SHORTCUT_ICON_OPTIONS.map((option) => {
							const IconComponent = getRuntimeShortcutIconComponent(option.value);
							return (
								<button
									key={option.value}
									type="button"
									aria-label={option.label}
									className={cn(
										"p-1.5 rounded hover:bg-surface-3",
										selectedOption.value === option.value && "bg-surface-3",
									)}
									onClick={() => {
										onSelect(option.value);
										setOpen(false);
									}}
								>
									<IconComponent size={14} />
								</button>
							);
						})}
					</div>
				</RadixPopover.Content>
			</RadixPopover.Portal>
		</RadixPopover.Root>
	);
}

export function RuntimeSettingsDialog({
	open,
	workspaceId,
	initialConfig = null,
	onOpenChange,
	onSaved,
	initialSection,
}: {
	open: boolean;
	workspaceId: string | null;
	initialConfig?: RuntimeConfigResponse | null;
	onOpenChange: (open: boolean) => void;
	onSaved?: () => void;
	initialSection?: RuntimeSettingsSection | null;
}): React.ReactElement {
	const { config, isLoading, isSaving, save } = useRuntimeConfig(open, workspaceId, initialConfig);
	const [selectedAgentId, setSelectedAgentId] = useState<RuntimeAgentId>("claude");
	const [fallbackAgentId, setFallbackAgentId] = useState<RuntimeAgentId | null>(null);
	const [agentApprovalMode, setAgentApprovalMode] = useState<RuntimeAgentApprovalMode>("full_auto");
	const [agentAttentionNotificationsEnabled, setAgentAttentionNotificationsEnabled] = useState(true);
	const [agentAttentionSoundEnabled, setAgentAttentionSoundEnabled] = useState(false);
	const [readyForReviewNotificationsEnabled, setReadyForReviewNotificationsEnabled] = useState(true);
	const [notificationPermission, setNotificationPermission] = useState<BrowserNotificationPermission>("unsupported");
	const [shortcuts, setShortcuts] = useState<RuntimeProjectShortcut[]>([]);
	const [commitPromptTemplate, setCommitPromptTemplate] = useState("");
	const [openPrPromptTemplate, setOpenPrPromptTemplate] = useState("");
	const [selectedPromptVariant, setSelectedPromptVariant] = useState<TaskGitAction>("commit");
	const [copiedVariableToken, setCopiedVariableToken] = useState<string | null>(null);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [pendingShortcutScrollIndex, setPendingShortcutScrollIndex] = useState<number | null>(null);
	const copiedVariableResetTimerRef = useRef<number | null>(null);
	const shortcutsSectionRef = useRef<HTMLHeadingElement | null>(null);
	const shortcutRowRefs = useRef<Array<HTMLDivElement | null>>([]);
	const controlsDisabled = isLoading || isSaving || config === null;
	const commitPromptTemplateDefault = config?.commitPromptTemplateDefault ?? "";
	const openPrPromptTemplateDefault = config?.openPrPromptTemplateDefault ?? "";
	const isCommitPromptAtDefault =
		normalizeTemplateForComparison(commitPromptTemplate) ===
		normalizeTemplateForComparison(commitPromptTemplateDefault);
	const isOpenPrPromptAtDefault =
		normalizeTemplateForComparison(openPrPromptTemplate) ===
		normalizeTemplateForComparison(openPrPromptTemplateDefault);
	const selectedPromptValue = selectedPromptVariant === "commit" ? commitPromptTemplate : openPrPromptTemplate;
	const selectedPromptDefaultValue =
		selectedPromptVariant === "commit" ? commitPromptTemplateDefault : openPrPromptTemplateDefault;
	const isSelectedPromptAtDefault =
		selectedPromptVariant === "commit" ? isCommitPromptAtDefault : isOpenPrPromptAtDefault;
	const selectedPromptPlaceholder =
		selectedPromptVariant === "commit" ? "Commit prompt template" : "PR prompt template";
	const refreshNotificationPermission = useCallback(() => {
		setNotificationPermission(getBrowserNotificationPermission());
	}, []);

	const supportedAgents = useMemo<RuntimeSettingsAgentRowModel[]>(() => {
		const agents =
			config?.agents.map((agent) => ({
				id: agent.id,
				label: agent.label,
				binary: agent.binary,
				installed: agent.installed,
			})) ??
			getRuntimeLaunchSupportedAgentCatalog().map((agent) => ({
				id: agent.id,
				label: agent.label,
				binary: agent.binary,
				installed: null,
			}));
		const orderIndexByAgentId = new Map(SETTINGS_AGENT_ORDER.map((agentId, index) => [agentId, index] as const));
		const orderedAgents = [...agents].sort((left, right) => {
			const leftOrderIndex = orderIndexByAgentId.get(left.id) ?? Number.MAX_SAFE_INTEGER;
			const rightOrderIndex = orderIndexByAgentId.get(right.id) ?? Number.MAX_SAFE_INTEGER;
			return leftOrderIndex - rightOrderIndex;
		});
		return orderedAgents.map((agent) => ({
			...agent,
			command: buildDisplayedAgentCommand(agent.id, agent.binary, agentApprovalMode),
		}));
	}, [agentApprovalMode, config?.agents]);
	const displayedAgents = useMemo(() => supportedAgents, [supportedAgents]);
	const configuredAgentId = config?.selectedAgentId ?? null;
	const configuredFallbackAgentId = config?.fallbackAgentId ?? null;
	const firstInstalledAgentId = displayedAgents.find((agent) => agent.installed)?.id;
	const fallbackSelectedAgentId = firstInstalledAgentId ?? displayedAgents[0]?.id ?? "claude";
	const initialSelectedAgentId = configuredAgentId ?? fallbackSelectedAgentId;
	const initialFallbackAgentId = configuredFallbackAgentId;
	const initialAgentApprovalMode = resolveAgentApprovalMode(config);
	const initialAgentAttentionNotificationsEnabled = config?.agentAttentionNotificationsEnabled ?? true;
	const initialAgentAttentionSoundEnabled = config?.agentAttentionSoundEnabled ?? false;
	const initialReadyForReviewNotificationsEnabled = config?.readyForReviewNotificationsEnabled ?? true;
	const initialShortcuts = config?.shortcuts ?? [];
	const initialCommitPromptTemplate = config?.commitPromptTemplate ?? "";
	const initialOpenPrPromptTemplate = config?.openPrPromptTemplate ?? "";
	const hasUnsavedChanges = useMemo(() => {
		if (!config) {
			return false;
		}
		if (selectedAgentId !== initialSelectedAgentId) {
			return true;
		}
		if (fallbackAgentId !== initialFallbackAgentId) {
			return true;
		}
		if (agentApprovalMode !== initialAgentApprovalMode) {
			return true;
		}
		if (agentAttentionNotificationsEnabled !== initialAgentAttentionNotificationsEnabled) {
			return true;
		}
		if (agentAttentionSoundEnabled !== initialAgentAttentionSoundEnabled) {
			return true;
		}
		if (readyForReviewNotificationsEnabled !== initialReadyForReviewNotificationsEnabled) {
			return true;
		}
		if (!areRuntimeProjectShortcutsEqual(shortcuts, initialShortcuts)) {
			return true;
		}
		if (
			normalizeTemplateForComparison(commitPromptTemplate) !==
			normalizeTemplateForComparison(initialCommitPromptTemplate)
		) {
			return true;
		}
		return (
			normalizeTemplateForComparison(openPrPromptTemplate) !==
			normalizeTemplateForComparison(initialOpenPrPromptTemplate)
		);
	}, [
		agentApprovalMode,
		commitPromptTemplate,
		config,
		initialAgentAttentionNotificationsEnabled,
		initialAgentAttentionSoundEnabled,
		initialAgentApprovalMode,
		initialFallbackAgentId,
		initialCommitPromptTemplate,
		initialOpenPrPromptTemplate,
		initialReadyForReviewNotificationsEnabled,
		initialSelectedAgentId,
		initialShortcuts,
		openPrPromptTemplate,
		agentAttentionNotificationsEnabled,
		agentAttentionSoundEnabled,
		readyForReviewNotificationsEnabled,
		fallbackAgentId,
		selectedAgentId,
		shortcuts,
	]);

	useEffect(() => {
		if (!open) {
			return;
		}
		setSelectedAgentId(configuredAgentId ?? fallbackSelectedAgentId);
		setFallbackAgentId(config?.fallbackAgentId ?? null);
		setAgentApprovalMode(resolveAgentApprovalMode(config));
		setAgentAttentionNotificationsEnabled(config?.agentAttentionNotificationsEnabled ?? true);
		setAgentAttentionSoundEnabled(config?.agentAttentionSoundEnabled ?? false);
		setReadyForReviewNotificationsEnabled(config?.readyForReviewNotificationsEnabled ?? true);
		setShortcuts(config?.shortcuts ?? []);
		setCommitPromptTemplate(config?.commitPromptTemplate ?? "");
		setOpenPrPromptTemplate(config?.openPrPromptTemplate ?? "");
		setSaveError(null);
	}, [
		config?.agentAttentionNotificationsEnabled,
		config?.agentAttentionSoundEnabled,
		config?.agentApprovalMode,
		config?.agentAutonomousModeEnabled,
		config?.fallbackAgentId,
		config?.commitPromptTemplate,
		config?.openPrPromptTemplate,
		config?.readyForReviewNotificationsEnabled,
		config?.selectedAgentId,
		config?.shortcuts,
		fallbackSelectedAgentId,
		open,
	]);

	useEffect(() => {
		if (!open) {
			return;
		}
		refreshNotificationPermission();
	}, [open, refreshNotificationPermission]);
	useWindowEvent("focus", open ? refreshNotificationPermission : null);

	useEffect(() => {
		if (!open || initialSection !== "shortcuts") {
			return;
		}
		const timeout = window.setTimeout(() => {
			shortcutsSectionRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
		}, 500);
		return () => {
			window.clearTimeout(timeout);
		};
	}, [initialSection, open]);

	useEffect(() => {
		if (pendingShortcutScrollIndex === null) {
			return;
		}
		const frame = window.requestAnimationFrame(() => {
			const target = shortcutRowRefs.current[pendingShortcutScrollIndex] ?? null;
			if (target) {
				target.scrollIntoView({ block: "nearest", behavior: "smooth" });
				const firstInput = target.querySelector("input");
				firstInput?.focus();
				setPendingShortcutScrollIndex(null);
			}
		});
		return () => {
			window.cancelAnimationFrame(frame);
		};
	}, [pendingShortcutScrollIndex, shortcuts]);

	useUnmount(() => {
		if (copiedVariableResetTimerRef.current !== null) {
			window.clearTimeout(copiedVariableResetTimerRef.current);
			copiedVariableResetTimerRef.current = null;
		}
	});

	const handleCopyVariableToken = (token: string) => {
		void (async () => {
			try {
				await navigator.clipboard.writeText(token);
				setCopiedVariableToken(token);
				if (copiedVariableResetTimerRef.current !== null) {
					window.clearTimeout(copiedVariableResetTimerRef.current);
				}
				copiedVariableResetTimerRef.current = window.setTimeout(() => {
					setCopiedVariableToken((current) => (current === token ? null : current));
					copiedVariableResetTimerRef.current = null;
				}, 2000);
			} catch {
				// Ignore clipboard failures.
			}
		})();
	};

	const handleSelectedPromptChange = (value: string) => {
		if (selectedPromptVariant === "commit") {
			setCommitPromptTemplate(value);
			return;
		}
		setOpenPrPromptTemplate(value);
	};

	const handleResetSelectedPrompt = () => {
		handleSelectedPromptChange(selectedPromptDefaultValue);
	};

	const handleSave = async () => {
		setSaveError(null);
		if (!config) {
			setSaveError("Runtime settings are still loading. Try again in a moment.");
			return;
		}
		const selectedAgent = displayedAgents.find((agent) => agent.id === selectedAgentId);
		if (!selectedAgent || selectedAgent.installed !== true) {
			setSaveError("Selected agent is not installed. Install it first or choose an installed agent.");
			return;
		}
		const normalizedFallbackAgentId = fallbackAgentId === selectedAgentId ? null : fallbackAgentId;
		if (normalizedFallbackAgentId) {
			const selectedFallbackAgent = displayedAgents.find((agent) => agent.id === normalizedFallbackAgentId);
			if (!selectedFallbackAgent || selectedFallbackAgent.installed !== true) {
				setSaveError("Fallback agent is not installed. Install it first or clear the fallback.");
				return;
			}
		}
		const shouldRequestNotificationPermission =
			!(initialAgentAttentionNotificationsEnabled || initialReadyForReviewNotificationsEnabled) &&
			(agentAttentionNotificationsEnabled || readyForReviewNotificationsEnabled) &&
			notificationPermission === "default";
		if (shouldRequestNotificationPermission) {
			const nextPermission = await requestBrowserNotificationPermission();
			setNotificationPermission(nextPermission);
		}
		const saved = await save({
			selectedAgentId,
			fallbackAgentId: normalizedFallbackAgentId,
			agentApprovalMode,
			agentAutonomousModeEnabled: agentApprovalMode === "full_auto",
			agentAttentionNotificationsEnabled,
			agentAttentionSoundEnabled,
			readyForReviewNotificationsEnabled,
			shortcuts,
			commitPromptTemplate,
			openPrPromptTemplate,
		});
		if (!saved) {
			setSaveError("Could not save runtime settings. Check runtime logs and try again.");
			return;
		}
		onSaved?.();
		onOpenChange(false);
	};

	const handleRequestPermission = () => {
		void (async () => {
			const nextPermission = await requestBrowserNotificationPermission();
			setNotificationPermission(nextPermission);
		})();
	};

	const handleOpenFilePath = useCallback(
		(filePath: string) => {
			setSaveError(null);
			void openFileOnHost(workspaceId, filePath).catch((error) => {
				const message = error instanceof Error ? error.message : String(error);
				setSaveError(`Could not open file on host: ${message}`);
			});
		},
		[workspaceId],
	);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogHeader title="Settings" icon={<Settings size={16} />} />
			<DialogBody>
				<h5 className="font-semibold text-text-primary m-0">Global</h5>
				<p
					className="text-text-secondary font-mono text-xs m-0 break-all"
					style={{ cursor: config?.globalConfigPath ? "pointer" : undefined }}
					onClick={() => {
						if (config?.globalConfigPath) {
							handleOpenFilePath(config.globalConfigPath);
						}
					}}
				>
					{config?.globalConfigPath
						? formatPathForDisplay(config.globalConfigPath)
						: "~/.config/fs-kanban/config.json"}
					{config?.globalConfigPath ? <ExternalLink size={12} className="inline ml-1.5 align-middle" /> : null}
				</p>

				<h6 className="font-semibold text-text-primary mt-3 mb-0">Agent runtime</h6>
				{displayedAgents.map((agent) => (
					<AgentRow
						key={agent.id}
						agent={agent}
						isSelected={agent.id === selectedAgentId}
						onSelect={() => setSelectedAgentId(agent.id)}
						disabled={controlsDisabled}
					/>
				))}
				{config === null ? (
					<p className="text-text-secondary py-2">Checking which CLIs are installed for this project...</p>
				) : null}
				<div className="mt-3">
					<span className="mb-1 block text-[11px] text-text-secondary">Manual retry fallback</span>
					<div className="relative inline-flex min-w-[240px] max-w-full">
						<select
							value={fallbackAgentId ?? ""}
							onChange={(event) => {
								const nextValue = event.target.value;
								setFallbackAgentId(nextValue === "" ? null : (nextValue as RuntimeAgentId));
							}}
							disabled={controlsDisabled}
							className="h-8 w-full appearance-none rounded-md border border-border bg-surface-2 pl-2 pr-7 text-[13px] text-text-primary focus:border-border-focus focus:outline-none disabled:opacity-40"
						>
							<option value="">No fallback</option>
							{displayedAgents.map((agent) => (
								<option key={agent.id} value={agent.id} disabled={agent.installed !== true}>
									{agent.installed ? agent.label : `${agent.label} (not installed)`}
								</option>
							))}
						</select>
						<ChevronDown
							size={14}
							className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-text-secondary"
						/>
					</div>
					<p className="mt-1 mb-0 text-[12px] text-text-secondary">
						Used as the first suggested alternate when retrying a failed or interrupted card.
					</p>
				</div>
				<div className="mt-3">
					<span className="mb-1 block text-[11px] text-text-secondary">Approval mode</span>
					<div className="grid gap-2">
						{AGENT_APPROVAL_MODE_OPTIONS.map((option) => {
							const selected = agentApprovalMode === option.value;
							return (
								<button
									key={option.value}
									type="button"
									disabled={controlsDisabled}
									onClick={() => setAgentApprovalMode(option.value)}
									className={cn(
										"rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-40",
										selected
											? "border-border-focus bg-accent/10"
											: "border-border bg-surface-2 hover:border-border-bright hover:bg-surface-3",
									)}
								>
									<div className="text-[13px] text-text-primary">{option.label}</div>
									<div className="mt-1 text-[12px] text-text-secondary">{option.description}</div>
								</button>
							);
						})}
					</div>
					<p className="mt-2 mb-0 text-[12px] text-text-secondary">
						Supervised mode only auto-approves narrow read-only prompts. Anything risky, write-capable, or
						ambiguous still stops and needs you.
					</p>
				</div>

				<div className="flex items-center justify-between mt-4 mb-1">
					<h6 className="font-semibold text-text-primary m-0">Git button prompts</h6>
				</div>
				<p className="text-text-secondary text-[13px] mt-0 mb-2">
					Modify the prompts sent to the agent when using Commit or Make PR on tasks in Review.
				</p>
				<div className="flex items-center justify-between gap-2 mb-2">
					<select
						value={selectedPromptVariant}
						onChange={(event) => setSelectedPromptVariant(event.target.value as TaskGitAction)}
						disabled={controlsDisabled}
						className="h-8 rounded-md border border-border bg-surface-2 px-2 text-[13px] text-text-primary focus:border-border-focus focus:outline-none"
						style={{ minWidth: 220 }}
					>
						{GIT_PROMPT_VARIANT_OPTIONS.map((option) => (
							<option key={option.value} value={option.value}>
								{option.label}
							</option>
						))}
					</select>
					<Button
						variant="ghost"
						size="sm"
						onClick={handleResetSelectedPrompt}
						disabled={controlsDisabled || isSelectedPromptAtDefault}
					>
						Reset
					</Button>
				</div>
				<textarea
					rows={5}
					value={selectedPromptValue}
					onChange={(event) => handleSelectedPromptChange(event.target.value)}
					placeholder={selectedPromptPlaceholder}
					disabled={controlsDisabled}
					className="w-full rounded-md border border-border bg-surface-2 p-3 text-[13px] text-text-primary font-mono placeholder:text-text-tertiary focus:border-border-focus focus:outline-none resize-none disabled:opacity-40"
				/>
				<p className="text-text-secondary text-[13px] mt-2 mb-2.5">
					Use{" "}
					<InlineUtilityButton
						text={
							copiedVariableToken === TASK_GIT_BASE_REF_PROMPT_VARIABLE.token
								? "Copied!"
								: TASK_GIT_BASE_REF_PROMPT_VARIABLE.token
						}
						monospace
						widthCh={Math.max(TASK_GIT_BASE_REF_PROMPT_VARIABLE.token.length, "Copied!".length) + 2}
						onClick={() => {
							handleCopyVariableToken(TASK_GIT_BASE_REF_PROMPT_VARIABLE.token);
						}}
						disabled={controlsDisabled}
					/>{" "}
					to reference {TASK_GIT_BASE_REF_PROMPT_VARIABLE.description}
				</p>
				<h6 className="font-semibold text-text-primary mt-4 mb-2">Notifications</h6>
				<div className="flex items-center gap-2">
					{renderSwitch({
						checked: agentAttentionNotificationsEnabled,
						disabled: controlsDisabled,
						onCheckedChange: setAgentAttentionNotificationsEnabled,
					})}
					<span className="text-[13px] text-text-primary">Notify when an agent needs you</span>
				</div>
				<div className="flex items-center gap-2 mt-2">
					{renderSwitch({
						checked: agentAttentionSoundEnabled,
						disabled: controlsDisabled,
						onCheckedChange: setAgentAttentionSoundEnabled,
					})}
					<span className="text-[13px] text-text-primary">Play a sound when an agent needs you</span>
				</div>
				<div className="flex items-center gap-2 mt-2">
					{renderSwitch({
						checked: readyForReviewNotificationsEnabled,
						disabled: controlsDisabled,
						onCheckedChange: setReadyForReviewNotificationsEnabled,
					})}
					<span className="text-[13px] text-text-primary">Notify when a task is ready for review</span>
				</div>
				<div className="flex items-center gap-2 mt-2 mb-2">
					<p className="text-text-secondary text-[13px] m-0">
						Browser permission: {formatNotificationPermissionStatus(notificationPermission)}
					</p>
					{notificationPermission !== "granted" && notificationPermission !== "unsupported" ? (
						<InlineUtilityButton
							text="Request permission"
							onClick={handleRequestPermission}
							disabled={controlsDisabled}
						/>
					) : null}
				</div>

				<h5 className="font-semibold text-text-primary mt-4 mb-0">Project</h5>
				<p
					className="text-text-secondary font-mono text-xs m-0 break-all"
					style={{ cursor: config?.projectConfigPath ? "pointer" : undefined }}
					onClick={() => {
						if (config?.projectConfigPath) {
							handleOpenFilePath(config.projectConfigPath);
						}
					}}
				>
					{config?.projectConfigPath
						? formatPathForDisplay(config.projectConfigPath)
						: "<project>/.fs-kanban/config.json"}
					{config?.projectConfigPath ? <ExternalLink size={12} className="inline ml-1.5 align-middle" /> : null}
				</p>

				<div className="flex items-center justify-between mt-3 mb-2">
					<h6 ref={shortcutsSectionRef} className="font-semibold text-text-primary m-0">
						Script shortcuts
					</h6>
					<Button
						variant="ghost"
						size="sm"
						icon={<Plus size={14} />}
						onClick={() => {
							setShortcuts((current) => {
								const nextLabel = getNextShortcutLabel(current, "Run");
								setPendingShortcutScrollIndex(current.length);
								return [
									...current,
									{
										label: nextLabel,
										command: "",
										icon: "play",
									},
								];
							});
						}}
						disabled={controlsDisabled}
					>
						Add
					</Button>
				</div>

				{shortcuts.map((shortcut, shortcutIndex) => (
					<div
						key={shortcutIndex}
						ref={(node) => {
							shortcutRowRefs.current[shortcutIndex] = node;
						}}
						className="grid gap-2 mb-1"
						style={{ gridTemplateColumns: "max-content 1fr 2fr auto" }}
					>
						<ShortcutIconPicker
							value={shortcut.icon}
							onSelect={(icon) =>
								setShortcuts((current) =>
									current.map((item, itemIndex) => (itemIndex === shortcutIndex ? { ...item, icon } : item)),
								)
							}
						/>
						<input
							value={shortcut.label}
							onChange={(event) =>
								setShortcuts((current) =>
									current.map((item, itemIndex) =>
										itemIndex === shortcutIndex ? { ...item, label: event.target.value } : item,
									),
								)
							}
							placeholder="Label"
							className="h-7 w-full rounded-md border border-border bg-surface-2 px-2 text-xs text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
						/>
						<input
							value={shortcut.command}
							onChange={(event) =>
								setShortcuts((current) =>
									current.map((item, itemIndex) =>
										itemIndex === shortcutIndex ? { ...item, command: event.target.value } : item,
									),
								)
							}
							placeholder="Command"
							className="h-7 w-full rounded-md border border-border bg-surface-2 px-2 text-xs text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
						/>
						<Button
							variant="ghost"
							size="sm"
							icon={<X size={14} />}
							aria-label={`Remove shortcut ${shortcut.label}`}
							onClick={() =>
								setShortcuts((current) => current.filter((_, itemIndex) => itemIndex !== shortcutIndex))
							}
						/>
					</div>
				))}
				{shortcuts.length === 0 ? (
					<p className="text-text-secondary text-[13px]">No shortcuts configured.</p>
				) : null}

				{saveError ? (
					<div className="flex gap-2 rounded-md border border-status-red/30 bg-status-red/5 p-3 text-[13px] mt-3">
						<span className="text-text-primary">{saveError}</span>
					</div>
				) : null}
			</DialogBody>
			<DialogFooter>
				<Button onClick={() => onOpenChange(false)} disabled={controlsDisabled}>
					Cancel
				</Button>
				<Button
					variant="primary"
					onClick={() => void handleSave()}
					disabled={controlsDisabled || !hasUnsavedChanges}
				>
					Save
				</Button>
			</DialogFooter>
		</Dialog>
	);
}
