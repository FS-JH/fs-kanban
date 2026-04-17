import type { ReactElement } from "react";

import { FileCode2, FileSpreadsheet, FileText, Image as ImageIcon, Paperclip, X } from "lucide-react";

import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/components/ui/cn";
import { buildTaskAttachmentPreviewUrl } from "@/runtime/task-attachments";
import type { TaskAttachment } from "@/types";

interface TaskAttachmentStripProps {
	attachments: TaskAttachment[];
	workspaceId?: string | null;
	onRemoveAttachment?: (attachmentId: string) => void;
	className?: string;
	label?: string | null;
}

function getTaskAttachmentPreviewSource(attachment: TaskAttachment, workspaceId?: string | null): string | null {
	if (attachment.kind !== "image") {
		return null;
	}
	if (attachment.legacyImageDataBase64?.trim()) {
		return `data:${attachment.mimeType};base64,${attachment.legacyImageDataBase64}`;
	}
	return workspaceId ? buildTaskAttachmentPreviewUrl(workspaceId, attachment) : null;
}

function getTaskAttachmentIcon(attachment: TaskAttachment): ReactElement {
	if (attachment.kind === "image") {
		return <ImageIcon size={14} className="shrink-0 text-text-secondary" />;
	}
	if (attachment.kind === "data") {
		return <FileSpreadsheet size={14} className="shrink-0 text-text-secondary" />;
	}
	if (attachment.kind === "text") {
		return <FileCode2 size={14} className="shrink-0 text-text-secondary" />;
	}
	if (attachment.kind === "document") {
		return <FileText size={14} className="shrink-0 text-text-secondary" />;
	}
	return <Paperclip size={14} className="shrink-0 text-text-secondary" />;
}

export function TaskAttachmentStrip({
	attachments,
	workspaceId = null,
	onRemoveAttachment,
	className,
	label = null,
}: TaskAttachmentStripProps): ReactElement | null {
	if (attachments.length === 0) {
		return null;
	}

	return (
		<div className={className}>
			{label ? <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-text-tertiary">{label}</div> : null}
			<div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto pr-1">
				{attachments.map((attachment) => {
					const previewSource = getTaskAttachmentPreviewSource(attachment, workspaceId);
					const preview = (
						<>
							{previewSource ? (
								<img
									src={previewSource}
									alt={attachment.name}
									className="h-5 w-5 rounded object-cover"
								/>
							) : (
								getTaskAttachmentIcon(attachment)
							)}
							<span className="min-w-0 max-w-40 truncate text-[11px] text-text-secondary">{attachment.name}</span>
							{onRemoveAttachment ? <X size={12} className="shrink-0 text-text-tertiary group-hover:text-accent" /> : null}
						</>
					);

					if (!onRemoveAttachment) {
						return (
							<div
								key={attachment.id}
								className="inline-flex max-w-[280px] min-w-0 items-center gap-1.5 rounded-md border border-border-bright bg-surface-2 px-1.5 py-1"
							>
								{preview}
							</div>
						);
					}

					return (
						<Tooltip key={attachment.id} content="Click to delete">
							<button
								type="button"
								onClick={() => onRemoveAttachment(attachment.id)}
								className={cn(
									"group inline-flex max-w-[280px] min-w-0 cursor-pointer items-center gap-1.5 rounded-md border border-border-bright bg-surface-2 px-1.5 py-1 hover:border-border-focus",
								)}
								aria-label={`Delete ${attachment.name}`}
							>
								{preview}
							</button>
						</Tooltip>
					);
				})}
			</div>
		</div>
	);
}
