// Layout component for the native Agent chat panel.
// Rendering lives here, while session state and action wiring come from the
// controller hook so multiple surfaces can share the same behavior.
import React, { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from "react";

import { AgentChatComposer } from "@/components/detail-panels/agent-chat-composer";
import { AgentChatMessageItem } from "@/components/detail-panels/agent-chat-message-item";
import {
	buildAgentModelPickerOptions,
	formatAgentSelectedModelButtonText,
} from "@/components/detail-panels/agent-model-picker-options";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ShimmeringText } from "@/components/ui/text-shimmer";
import { useAgentChatPanelController } from "@/hooks/use-agent-chat-panel-controller";
import type { AgentChatActionResult } from "@/hooks/use-agent-chat-runtime-actions";
import type { AgentChatMessage } from "@/hooks/use-agent-chat-session";
import { useRuntimeSettingsAgentController } from "@/hooks/use-runtime-settings-agent-controller";
import type {
	RuntimeClineReasoningEffort,
	RuntimeConfigResponse,
	RuntimeTaskSessionMode,
	RuntimeTaskSessionSummary,
} from "@/runtime/types";
import type { TaskImage } from "@/types";

const BOTTOM_LOCK_THRESHOLD_PX = 24;

const ThinkingShimmer = React.memo(function ThinkingShimmer() {
	return (
		<div className="px-1.5">
			<ShimmeringText
				text="Thinking..."
				className="text-sm"
				duration={2.5}
				spread={5}
				repeatDelay={0}
				startOnView={false}
			/>
		</div>
	);
});

export interface AgentChatPanelHandle {
	appendToDraft: (text: string) => void;
	sendText: (text: string) => Promise<void>;
}

export interface AgentChatPanelProps {
	taskId: string;
	summary: RuntimeTaskSessionSummary | null;
	taskColumnId?: string;
	defaultMode?: RuntimeTaskSessionMode;
	composerPlaceholder?: string;
	showComposerModeToggle?: boolean;
	showRightBorder?: boolean;
	workspaceId?: string | null;
	runtimeConfig?: RuntimeConfigResponse | null;
	onAgentSettingsSaved?: () => void;
	onSendMessage?: (
		taskId: string,
		text: string,
		options?: { mode?: RuntimeTaskSessionMode; images?: TaskImage[] },
	) => Promise<AgentChatActionResult>;
	onCancelTurn?: (taskId: string) => Promise<{ ok: boolean; message?: string }>;
	onLoadMessages?: (taskId: string) => Promise<AgentChatMessage[] | null>;
	incomingMessages?: AgentChatMessage[] | null;
	incomingMessage?: AgentChatMessage | null;
	onCommit?: () => void;
	onOpenPr?: () => void;
	isCommitLoading?: boolean;
	isOpenPrLoading?: boolean;
	onMoveToTrash?: () => void;
	isMoveToTrashLoading?: boolean;
	onCancelAutomaticAction?: () => void;
	cancelAutomaticActionLabel?: string | null;
	showMoveToTrash?: boolean;
}

export const AgentChatPanel = React.forwardRef<AgentChatPanelHandle, AgentChatPanelProps>(function AgentChatPanel({
	taskId,
	summary,
	taskColumnId = "in_progress",
	defaultMode = "act",
	composerPlaceholder = "Ask the agent to add, edit, start, or link tasks",
	showComposerModeToggle = true,
	showRightBorder = true,
	workspaceId = null,
	runtimeConfig = null,
	onAgentSettingsSaved,
	onSendMessage,
	onCancelTurn,
	onLoadMessages,
	incomingMessages,
	incomingMessage,
	onCommit,
	onOpenPr,
	isCommitLoading = false,
	isOpenPrLoading = false,
	onMoveToTrash,
	isMoveToTrashLoading = false,
	onCancelAutomaticAction,
	cancelAutomaticActionLabel,
	showMoveToTrash = false,
},
ref,
): ReactElement {
	const {
		draft,
		setDraft,
		messages,
		error,
		isSending,
		canSend,
		canCancel,
		showReviewActions,
		showAgentProgressIndicator,
		showActionFooter,
		showCancelAutomaticAction,
		handleSendText,
		handleSendDraft,
		handleCancelTurn,
	} = useAgentChatPanelController({
		taskId,
		summary,
		taskColumnId,
		onSendMessage,
		onCancelTurn,
		onLoadMessages,
		incomingMessages,
		incomingMessage,
		onCommit,
		onOpenPr,
		onMoveToTrash,
		onCancelAutomaticAction,
		cancelAutomaticActionLabel,
		showMoveToTrash,
	});
	const scrollContainerRef = useRef<HTMLDivElement | null>(null);
	// TODO: Persist per-task mode immediately when toggled so page refresh restores unsent mode changes.
	const modeByTaskIdRef = useRef<Map<string, RuntimeTaskSessionMode>>(new Map());
	const [composerError, setComposerError] = useState<string | null>(null);
	const [isAutoScrollEnabled, setIsAutoScrollEnabled] = useState(true);
	const [isSavingModel, setIsSavingModel] = useState(false);
	const [mode, setMode] = useState<RuntimeTaskSessionMode>(() => {
		const persistedMode = modeByTaskIdRef.current.get(taskId);
		return persistedMode ?? summary?.mode ?? defaultMode;
	});
	const [draftImages, setDraftImages] = useState<TaskImage[]>([]);
	const agentSettings = useRuntimeSettingsAgentController({
		open: true,
		workspaceId,
		selectedAgentId: "cline",
		config: runtimeConfig,
	});

	const modelPickerOptions = useMemo(
		() => buildAgentModelPickerOptions(agentSettings.providerId, agentSettings.providerModels),
		[agentSettings.providerId, agentSettings.providerModels],
	);
	const modelOptions = modelPickerOptions.options;

	const selectedModel = useMemo(
		() => agentSettings.providerModels.find((model) => model.id === agentSettings.modelId) ?? null,
		[agentSettings.modelId, agentSettings.providerModels],
	);
	const reasoningEnabledModelIds = useMemo(
		() => agentSettings.providerModels.filter((model) => model.supportsReasoningEffort).map((model) => model.id),
		[agentSettings.providerModels],
	);

	const selectedModelButtonText = useMemo(() => {
		if (isSavingModel) {
			return "Saving model...";
		}
		if (agentSettings.isLoadingProviderModels) {
			return "Loading models...";
		}
		const selectedOption = modelOptions.find((option) => option.value === agentSettings.modelId);
		const trimmedModelId = agentSettings.modelId.trim();
		const selectedModelName = selectedOption?.label ?? (trimmedModelId.length > 0 ? trimmedModelId : "Select model");
		return formatAgentSelectedModelButtonText({
			modelName: selectedModelName,
			reasoningEffort: agentSettings.reasoningEffort,
			showReasoningEffort: agentSettings.selectedModelSupportsReasoningEffort,
		});
	}, [
		agentSettings.isLoadingProviderModels,
		agentSettings.modelId,
		agentSettings.reasoningEffort,
		agentSettings.selectedModelSupportsReasoningEffort,
		isSavingModel,
		modelOptions,
	]);

	const panelError = composerError ?? error;
	const attachmentWarningMessage =
		draftImages.length > 0 && selectedModel?.supportsVision === false
			? "The selected model may not accept image input. Choose a vision-capable model to use these images."
			: null;

	const isPinnedToBottom = useCallback((container: HTMLDivElement): boolean => {
		const remainingDistance = container.scrollHeight - container.scrollTop - container.clientHeight;
		return remainingDistance <= BOTTOM_LOCK_THRESHOLD_PX;
	}, []);

	const handleMessageListScroll = useCallback(() => {
		const container = scrollContainerRef.current;
		if (!container) {
			return;
		}
		const nextIsAutoScrollEnabled = isPinnedToBottom(container);
		setIsAutoScrollEnabled((currentValue) =>
			currentValue === nextIsAutoScrollEnabled ? currentValue : nextIsAutoScrollEnabled,
		);
	}, [isPinnedToBottom]);

	useLayoutEffect(() => {
		const container = scrollContainerRef.current;
		if (!container || !isAutoScrollEnabled) {
			return;
		}
		container.scrollTop = container.scrollHeight;
	}, [
		isAutoScrollEnabled,
		messages,
		showAgentProgressIndicator,
		showActionFooter,
		showReviewActions,
		showCancelAutomaticAction,
	]);

	useEffect(() => {
		setComposerError(null);
	}, [taskId]);

	useEffect(() => {
		setIsAutoScrollEnabled(true);
	}, [taskId]);

	useEffect(() => {
		const persistedMode = modeByTaskIdRef.current.get(taskId);
		const nextMode = persistedMode ?? summary?.mode ?? defaultMode;
		modeByTaskIdRef.current.set(taskId, nextMode);
		setMode(nextMode);
		setDraftImages([]);
	}, [defaultMode, summary?.mode, taskId]);

	const handleModeChange = useCallback(
		(nextMode: RuntimeTaskSessionMode) => {
			modeByTaskIdRef.current.set(taskId, nextMode);
			setMode(nextMode);
		},
		[taskId],
	);

	type PersistAgentModelSettingsOverrides = {
		modelId?: string;
		reasoningEffort?: RuntimeClineReasoningEffort | "";
	};

	const persistAgentModelSettings = useCallback(
		async (overrides?: PersistAgentModelSettingsOverrides): Promise<boolean> => {
			if (!workspaceId) {
				setComposerError("Select a workspace before choosing a model.");
				return false;
			}
			if (agentSettings.providerId.trim().length === 0) {
				setComposerError("Choose a provider in Settings before selecting a model.");
				return false;
			}
			setComposerError(null);
			setIsSavingModel(true);
			try {
				const result = await agentSettings.saveProviderSettings({
					modelId: overrides?.modelId ?? agentSettings.modelId,
					reasoningEffort:
						overrides && "reasoningEffort" in overrides
							? overrides.reasoningEffort || null
							: agentSettings.reasoningEffort || null,
				});
				if (!result.ok) {
					setComposerError(result.message ?? "Could not save model settings.");
					return false;
				}
				onAgentSettingsSaved?.();
				return true;
			} finally {
				setIsSavingModel(false);
			}
		},
		[agentSettings, onAgentSettingsSaved, workspaceId],
	);

	const handleSelectModel = useCallback(
		(nextModelId: string) => {
			if (nextModelId.trim() === agentSettings.modelId.trim()) {
				return;
			}
			agentSettings.setModelId(nextModelId);
			void persistAgentModelSettings({ modelId: nextModelId });
		},
		[agentSettings.modelId, agentSettings.setModelId, persistAgentModelSettings],
	);

	const handleSelectReasoningEffort = useCallback(
		(nextReasoningEffort: RuntimeClineReasoningEffort | "") => {
			if (nextReasoningEffort === agentSettings.reasoningEffort) {
				return;
			}
			agentSettings.setReasoningEffort(nextReasoningEffort);
			void persistAgentModelSettings({ reasoningEffort: nextReasoningEffort });
		},
		[agentSettings.reasoningEffort, agentSettings.setReasoningEffort, persistAgentModelSettings],
	);

	const handleAppendToDraft = useCallback(
		(text: string) => {
			const trimmed = text.trim();
			if (trimmed.length === 0) {
				return;
			}
			if (draft.trim().length === 0) {
				setDraft(trimmed);
				return;
			}
			setDraft(`${draft.trimEnd()}\n\n${trimmed}`);
		},
		[draft, setDraft],
	);

	const handleSendComposerText = useCallback(
		async (text: string): Promise<void> => {
			if (isSavingModel) {
				return;
			}
			if (agentSettings.hasUnsavedChanges) {
				const saved = await persistAgentModelSettings();
				if (!saved) {
					return;
				}
			}
			await handleSendText(text, mode);
		},
		[agentSettings.hasUnsavedChanges, handleSendText, isSavingModel, mode, persistAgentModelSettings],
	);

	useImperativeHandle(
		ref,
		() => ({
			appendToDraft: handleAppendToDraft,
			sendText: handleSendComposerText,
		}),
		[handleAppendToDraft, handleSendComposerText],
	);

	const handleComposerSend = useCallback(async () => {
		if (isSavingModel) {
			return;
		}
		if (agentSettings.hasUnsavedChanges) {
			const saved = await persistAgentModelSettings();
			if (!saved) {
				return;
			}
		}
		const sent = await handleSendDraft(mode, draftImages);
		if (sent) {
			setDraftImages([]);
		}
	}, [agentSettings.hasUnsavedChanges, draftImages, handleSendDraft, isSavingModel, mode, persistAgentModelSettings]);

	return (
		<div
			className="flex min-h-0 min-w-0 flex-1 flex-col"
			style={{ borderRight: showRightBorder ? "1px solid var(--color-border)" : undefined }}
		>
			<div
				ref={scrollContainerRef}
				className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 py-3"
				onScroll={handleMessageListScroll}
			>
				{messages.map((message) => (
					<AgentChatMessageItem key={message.id} message={message} />
				))}
				{showAgentProgressIndicator ? <ThinkingShimmer /> : null}
			</div>
			{panelError ? (
				<div className="border-t border-status-red/30 bg-status-red/10 px-2 py-2 text-xs text-status-red">
					{panelError}
				</div>
			) : null}
			<div className="px-2 py-3">
				<AgentChatComposer
					taskId={taskId}
					draft={draft}
					onDraftChange={setDraft}
					images={draftImages}
					onImagesChange={setDraftImages}
					placeholder={composerPlaceholder}
					mode={mode}
					onModeChange={handleModeChange}
					showModeToggle={showComposerModeToggle}
					canSend={canSend}
					canCancel={canCancel}
					onSend={handleComposerSend}
					onCancel={handleCancelTurn}
					modelOptions={modelOptions}
					recommendedModelIds={modelPickerOptions.recommendedModelIds}
					pinSelectedModelToTop={modelPickerOptions.shouldPinSelectedModelToTop}
					selectedModelId={agentSettings.modelId}
					selectedModelButtonText={selectedModelButtonText}
					onSelectModel={handleSelectModel}
					reasoningEnabledModelIds={reasoningEnabledModelIds}
					selectedReasoningEffort={agentSettings.reasoningEffort}
					onSelectReasoningEffort={handleSelectReasoningEffort}
					isModelLoading={agentSettings.isLoadingProviderModels}
					isModelSaving={isSavingModel}
					modelPickerDisabled={isSavingModel || agentSettings.providerId.trim().length === 0}
					isSending={isSavingModel || isSending}
					warningMessage={summary?.warningMessage ?? null}
					attachmentWarningMessage={attachmentWarningMessage}
					workspaceId={workspaceId}
				/>
			</div>
			{showActionFooter ? (
				<div className="flex flex-col gap-2 px-3 pb-3">
					{showReviewActions ? (
						<div className="flex gap-2">
							<Button
								variant="primary"
								size="sm"
								fill
								disabled={isCommitLoading || isOpenPrLoading}
								onClick={onCommit}
							>
								{isCommitLoading ? "..." : "Commit"}
							</Button>
							<Button
								variant="primary"
								size="sm"
								fill
								disabled={isCommitLoading || isOpenPrLoading}
								onClick={onOpenPr}
							>
								{isOpenPrLoading ? "..." : "Open PR"}
							</Button>
						</div>
					) : null}
					{cancelAutomaticActionLabel && onCancelAutomaticAction ? (
						<Button variant="default" fill onClick={onCancelAutomaticAction}>
							{cancelAutomaticActionLabel}
						</Button>
					) : null}
					<Button variant="danger" fill disabled={isMoveToTrashLoading} onClick={onMoveToTrash}>
						{isMoveToTrashLoading ? <Spinner size={14} /> : "Move Card To Trash"}
					</Button>
				</div>
			) : null}
		</div>
	);
});

AgentChatPanel.displayName = "AgentChatPanel";
