import { Paperclip } from "lucide-react";
import type { ChangeEvent, ClipboardEvent, DragEvent, KeyboardEvent, ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { notifyError } from "@/components/app-toaster";
import {
	applyAgentComposerCompletion,
	buildMentionInsertText,
	detectActiveAgentComposerToken,
} from "@/components/detail-panels/agent-chat-composer-completion";
import { InlineCompletionPicker, type InlineCompletionItem } from "@/components/inline-completion-picker";
import { ACCEPTED_TASK_ATTACHMENT_INPUT_ACCEPT, collectAttachmentFilesFromDataTransfer } from "@/components/task-attachment-input-utils";
import { TaskAttachmentStrip } from "@/components/task-attachment-strip";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { uploadTaskAttachment } from "@/runtime/task-attachments";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { TaskAttachment } from "@/types";
import { useDebouncedEffect } from "@/utils/react-use";

const FILE_MENTION_LIMIT = 8;
const MENTION_QUERY_DEBOUNCE_MS = 120;
const TEXTAREA_MAX_HEIGHT = 200;

interface TaskPromptComposerProps {
	id?: string;
	value: string;
	onValueChange: (value: string) => void;
	attachments?: TaskAttachment[];
	onAttachmentsChange?: (attachments: TaskAttachment[]) => void;
	onSubmit?: () => void;
	onSubmitAndStart?: () => void;
	onEscape?: () => void;
	placeholder?: string;
	disabled?: boolean;
	enabled?: boolean;
	autoFocus?: boolean;
	workspaceId?: string | null;
	showAttachButton?: boolean;
}

export function TaskPromptComposer({
	id,
	value,
	onValueChange,
	attachments = [],
	onAttachmentsChange,
	onSubmit,
	onSubmitAndStart,
	onEscape,
	placeholder,
	disabled,
	enabled = true,
	autoFocus = false,
	workspaceId = null,
	showAttachButton = true,
}: TaskPromptComposerProps): ReactElement {
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const mentionSearchRequestIdRef = useRef(0);
	const [cursorIndex, setCursorIndex] = useState(0);
	const [mentionItems, setMentionItems] = useState<InlineCompletionItem[]>([]);
	const [mentionInsertTextMap, setMentionInsertTextMap] = useState(new Map<string, string>());
	const [isMentionSearchLoading, setIsMentionSearchLoading] = useState(false);
	const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);
	const [isSuggestionPickerOpen, setIsSuggestionPickerOpen] = useState(false);
	const [isDragOver, setIsDragOver] = useState(false);
	const [isUploadingAttachments, setIsUploadingAttachments] = useState(false);

	const autoResizeTextarea = useCallback(() => {
		const textarea = textareaRef.current;
		if (!textarea) {
			return;
		}
		textarea.style.height = "auto";
		textarea.style.height = `${Math.min(textarea.scrollHeight, TEXTAREA_MAX_HEIGHT)}px`;
	}, []);

	useEffect(() => {
		autoResizeTextarea();
	}, [autoResizeTextarea, value]);

	const activeToken = useMemo(() => {
		const token = detectActiveAgentComposerToken(value, cursorIndex);
		if (token && token.kind !== "mention") {
			return null;
		}
		return token;
	}, [cursorIndex, value]);

	useEffect(() => {
		if (!enabled || !activeToken) {
			mentionSearchRequestIdRef.current += 1;
			setMentionItems([]);
			setMentionInsertTextMap(new Map());
			setIsMentionSearchLoading(false);
		}
	}, [activeToken, enabled, workspaceId]);

	useDebouncedEffect(
		() => {
			if (!enabled || !activeToken || !workspaceId) {
				return;
			}
			const requestId = ++mentionSearchRequestIdRef.current;
			setIsMentionSearchLoading(true);
			void (async () => {
				try {
					const trpcClient = getRuntimeTrpcClient(workspaceId);
					const payload = await trpcClient.workspace.searchFiles.query({
						query: activeToken.query,
						limit: FILE_MENTION_LIMIT,
					});
					if (requestId !== mentionSearchRequestIdRef.current) {
						return;
					}
					const files = Array.isArray(payload.files) ? payload.files : [];
					const insertMap = new Map<string, string>();
					const items: InlineCompletionItem[] = files.map((file) => {
						const insertText = buildMentionInsertText(file.path);
						insertMap.set(file.path, insertText);
						return { id: file.path, label: file.path };
					});
					setMentionItems(items);
					setMentionInsertTextMap(insertMap);
				} catch {
					if (requestId === mentionSearchRequestIdRef.current) {
						setMentionItems([]);
						setMentionInsertTextMap(new Map());
					}
				} finally {
					if (requestId === mentionSearchRequestIdRef.current) {
						setIsMentionSearchLoading(false);
					}
				}
			})();
		},
		MENTION_QUERY_DEBOUNCE_MS,
		[activeToken, enabled, workspaceId],
	);

	const suggestions = useMemo(() => {
		return enabled && activeToken ? mentionItems : [];
	}, [activeToken, enabled, mentionItems]);

	useEffect(() => {
		setSelectedSuggestionIndex(0);
		setIsSuggestionPickerOpen(true);
	}, [activeToken?.kind, activeToken?.query, activeToken?.start]);

	useEffect(() => {
		if (!autoFocus || disabled || !enabled) {
			return;
		}
		window.requestAnimationFrame(() => {
			if (!textareaRef.current) {
				return;
			}
			const cursor = textareaRef.current.value.length;
			textareaRef.current.focus();
			textareaRef.current.setSelectionRange(cursor, cursor);
			setCursorIndex(cursor);
		});
	}, [autoFocus, disabled, enabled]);

	const applySuggestion = useCallback(
		(item: InlineCompletionItem) => {
			if (!activeToken) {
				return;
			}
			const insertText = mentionInsertTextMap.get(item.id) ?? `@${item.id}`;
			const next = applyAgentComposerCompletion(value, activeToken, insertText);
			onValueChange(next.value);
			window.requestAnimationFrame(() => {
				if (!textareaRef.current) {
					return;
				}
				textareaRef.current.focus();
				textareaRef.current.setSelectionRange(next.cursor, next.cursor);
				setCursorIndex(next.cursor);
			});
		},
		[activeToken, mentionInsertTextMap, onValueChange, value],
	);

	const handleTextareaKeyDown = useCallback(
		(event: KeyboardEvent<HTMLTextAreaElement>) => {
			if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				if (event.shiftKey) {
					if (onSubmitAndStart) {
						onSubmitAndStart();
						return;
					}
				}
				onSubmit?.();
				return;
			}

			const canShowSuggestions = isSuggestionPickerOpen && suggestions.length > 0;
			if (canShowSuggestions && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
				event.preventDefault();
				const direction = event.key === "ArrowDown" ? 1 : -1;
				setSelectedSuggestionIndex((index) => {
					const nextIndex = index + direction;
					if (nextIndex < 0) {
						return suggestions.length - 1;
					}
					if (nextIndex >= suggestions.length) {
						return 0;
					}
					return nextIndex;
				});
				return;
			}

			if (canShowSuggestions && (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey))) {
				event.preventDefault();
				const selectedItem = suggestions[selectedSuggestionIndex] ?? suggestions[0];
				if (selectedItem) {
					applySuggestion(selectedItem);
				}
				return;
			}

			if (event.key === "Escape" && canShowSuggestions) {
				event.preventDefault();
				setIsSuggestionPickerOpen(false);
				return;
			}

			if (event.key === "Escape") {
				event.preventDefault();
				onEscape?.();
			}
		},
		[applySuggestion, isSuggestionPickerOpen, onEscape, onSubmit, onSubmitAndStart, selectedSuggestionIndex, suggestions],
	);

	const appendAttachments = useCallback(
		(newAttachments: TaskAttachment[]) => {
			if (!onAttachmentsChange || newAttachments.length === 0) {
				return;
			}
			onAttachmentsChange([...attachments, ...newAttachments]);
		},
		[attachments, onAttachmentsChange],
	);

	const uploadFiles = useCallback(
		async (files: File[]) => {
			if (!workspaceId || !onAttachmentsChange || files.length === 0) {
				return;
			}
			setIsUploadingAttachments(true);
			try {
				const uploadedAttachments = await Promise.all(files.map(async (file) => await uploadTaskAttachment(workspaceId, file)));
				appendAttachments(uploadedAttachments);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notifyError(message);
			} finally {
				setIsUploadingAttachments(false);
			}
		},
		[appendAttachments, onAttachmentsChange, workspaceId],
	);

	const handlePaste = useCallback(
		(event: ClipboardEvent<HTMLTextAreaElement>) => {
			if (!onAttachmentsChange || !event.clipboardData) {
				return;
			}
			const attachmentFiles = collectAttachmentFilesFromDataTransfer(event.clipboardData);
			if (attachmentFiles.length === 0) {
				return;
			}
			event.preventDefault();
			void uploadFiles(attachmentFiles);
		},
		[onAttachmentsChange, uploadFiles],
	);

	const handleDrop = useCallback(
		(event: DragEvent<HTMLDivElement>) => {
			setIsDragOver(false);
			if (!onAttachmentsChange || !event.dataTransfer) {
				return;
			}
			const attachmentFiles = collectAttachmentFilesFromDataTransfer(event.dataTransfer);
			if (attachmentFiles.length === 0) {
				return;
			}
			event.preventDefault();
			void uploadFiles(attachmentFiles);
		},
		[onAttachmentsChange, uploadFiles],
	);

	const handleDragOver = useCallback(
		(event: DragEvent<HTMLDivElement>) => {
			if (!onAttachmentsChange) {
				return;
			}
			const hasFiles = event.dataTransfer.types.includes("Files");
			if (!hasFiles) {
				return;
			}
			event.preventDefault();
			setIsDragOver(true);
		},
		[onAttachmentsChange],
	);

	const handleDragLeave = useCallback(
		(event: DragEvent<HTMLDivElement>) => {
			// Only clear drag state when leaving the drop zone container,
			// not when moving between child elements within it.
			if (event.currentTarget.contains(event.relatedTarget as Node)) {
				return;
			}
			setIsDragOver(false);
		},
		[],
	);

	const handleRemoveAttachment = useCallback(
		(attachmentId: string) => {
			onAttachmentsChange?.(attachments.filter((attachment) => attachment.id !== attachmentId));
		},
		[attachments, onAttachmentsChange],
	);

	const handleAttachClick = useCallback(() => {
		fileInputRef.current?.click();
	}, []);

	const handleFileInputChange = useCallback(
		(event: ChangeEvent<HTMLInputElement>) => {
			if (!onAttachmentsChange || !event.currentTarget.files) {
				return;
			}
			const files = Array.from(event.currentTarget.files);
			void uploadFiles(files).finally(() => {
				event.currentTarget.value = "";
			});
		},
		[onAttachmentsChange, uploadFiles],
	);

	const showSuggestions = Boolean(enabled && isSuggestionPickerOpen && activeToken);

	return (
		<div>
			<div
				className="relative"
				onDrop={handleDrop}
				onDragOver={handleDragOver}
				onDragLeave={handleDragLeave}
			>
				<InlineCompletionPicker
					open={showSuggestions}
					items={suggestions}
					selectedIndex={selectedSuggestionIndex}
					onSelectItem={applySuggestion}
					onHoverItem={setSelectedSuggestionIndex}
					isLoading={isMentionSearchLoading}
					loadingMessage="Loading files..."
					emptyMessage="No matching files."
				>
					<textarea
						id={id}
						ref={textareaRef}
						value={value}
						onChange={(event) => {
							onValueChange(event.target.value);
							setCursorIndex(event.target.selectionStart ?? event.target.value.length);
						}}
						onKeyDown={handleTextareaKeyDown}
						onClick={(event) =>
							setCursorIndex(event.currentTarget.selectionStart ?? event.currentTarget.value.length)
						}
						onKeyUp={(event) =>
							setCursorIndex(event.currentTarget.selectionStart ?? event.currentTarget.value.length)
						}
						onPaste={handlePaste}
						placeholder={placeholder ?? "Describe the task"}
						disabled={disabled}
						className={cn(
							"w-full rounded-md border bg-surface-3 p-3 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none",
							isDragOver ? "border-accent border-dashed" : "border-border-bright",
						)}
						style={{
							minHeight: 80,
							maxHeight: TEXTAREA_MAX_HEIGHT,
							resize: "none",
							overflowY: "auto",
						}}
					/>
				</InlineCompletionPicker>
				{isDragOver ? (
					<div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-md bg-accent/5">
						<div className="flex items-center gap-1.5 text-[12px] text-accent font-medium">
							<Paperclip size={14} />
							<span>Drop file here</span>
						</div>
					</div>
				) : null}
			</div>

			{attachments.length > 0 ? (
				<TaskAttachmentStrip
					attachments={attachments}
					workspaceId={workspaceId}
					onRemoveAttachment={handleRemoveAttachment}
					className="mt-1.5"
				/>
			) : null}

			{onAttachmentsChange && showAttachButton ? (
				<>
					<input
						ref={fileInputRef}
						type="file"
						accept={ACCEPTED_TASK_ATTACHMENT_INPUT_ACCEPT}
						multiple
						className="hidden"
						onChange={handleFileInputChange}
					/>
					<div className={attachments.length > 0 ? "mt-1" : "mt-1.5"}>
						<Button
							variant="ghost"
							size="sm"
							icon={<Paperclip size={14} />}
							onClick={handleAttachClick}
							disabled={disabled || !enabled || !workspaceId || isUploadingAttachments}
						>
							{isUploadingAttachments ? "Uploading..." : "Attach file"}
						</Button>
					</div>
				</>
			) : null}
		</div>
	);
}
