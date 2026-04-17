import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";

import type { RuntimeTaskAttachment, RuntimeTaskImage } from "../core/api-contract.js";
import { getWorkspaceDirectoryPath } from "../state/workspace-state.js";
import { getTaskAttachmentsRootPath, resolveExistingStoredTaskAttachmentPath } from "../workspace/task-attachments.js";

const IMAGE_EXTENSION_BY_MIME_TYPE: Record<string, string> = {
	"image/gif": ".gif",
	"image/jpeg": ".jpg",
	"image/png": ".png",
	"image/svg+xml": ".svg",
	"image/webp": ".webp",
};

function sanitizeFileNameSegment(value: string): string {
	const normalized = value.normalize("NFKD").replaceAll(/[^A-Za-z0-9._-]+/g, "-");
	const trimmed = normalized.replaceAll(/^-+|-+$/g, "");
	return trimmed.length > 0 ? trimmed : "attachment";
}

function resolveInlineImageExtension(image: RuntimeTaskImage): string {
	const name = image.name?.trim();
	const nameExtension = name ? extname(name).toLowerCase() : "";
	if (nameExtension) {
		return nameExtension;
	}
	return IMAGE_EXTENSION_BY_MIME_TYPE[image.mimeType.toLowerCase()] ?? "";
}

function buildInlineImageFileName(image: RuntimeTaskImage, index: number): string {
	const displayName = image.name?.trim();
	const extension = resolveInlineImageExtension(image);
	const baseName = displayName ? basename(displayName, extname(displayName)) : `image-${index + 1}`;
	return `${String(index + 1).padStart(2, "0")}-${sanitizeFileNameSegment(baseName)}${extension}`;
}

function buildTaskPromptWithAttachmentPaths(
	prompt: string,
	entries: Array<{ path: string; name: string; kind: string }>,
	format: "attachments" | "images",
): string {
	const lines =
		format === "images"
			? [
					"Attached reference images:",
					...entries.map((entry, index) => `${index + 1}. ${entry.path} (${entry.name})`),
				]
			: [
					"Attached task files:",
					...entries.map((entry, index) => `${index + 1}. [${entry.kind}] ${entry.path} (${entry.name})`),
				];
	const trimmedPrompt = prompt.trim();
	if (!trimmedPrompt) {
		return lines.join("\n");
	}
	return [...lines, "", "Task:", trimmedPrompt].join("\n");
}

async function materializeInlineImageEntries(images: RuntimeTaskImage[]): Promise<Array<{ path: string; name: string; kind: string }>> {
	if (images.length === 0) {
		return [];
	}
	const tempDir = await mkdtemp(join(tmpdir(), "kanban-task-attachments-"));
	return await Promise.all(
		images.map(async (image, index) => {
			const filePath = join(tempDir, buildInlineImageFileName(image, index));
			await writeFile(filePath, Buffer.from(image.data, "base64"));
			return {
				path: filePath,
				name: image.name?.trim() || `image-${index + 1}`,
				kind: "image",
			};
		}),
	);
}

async function resolveStoredAttachmentEntries(
	workspaceId: string,
	attachments: RuntimeTaskAttachment[],
): Promise<Array<{ path: string; name: string; kind: string }>> {
	const attachmentsRootPath = getTaskAttachmentsRootPath(getWorkspaceDirectoryPath(workspaceId));
	const entries: Array<{ path: string; name: string; kind: string }> = [];
	for (const attachment of attachments) {
		const storageKey = attachment.storageKey.trim();
		if (!storageKey) {
			continue;
		}
		const filePath = await resolveExistingStoredTaskAttachmentPath(attachmentsRootPath, storageKey);
		if (!filePath) {
			continue;
		}
		entries.push({
			path: filePath,
			name: attachment.name.trim() || storageKey,
			kind: attachment.kind,
		});
	}
	return entries;
}

export async function prepareTaskPromptWithAttachments(input: {
	prompt: string;
	attachments?: RuntimeTaskAttachment[];
	images?: RuntimeTaskImage[];
	workspaceId?: string;
}): Promise<string> {
	const attachmentEntries: Array<{ path: string; name: string; kind: string }> = [];
	const workspaceId = input.workspaceId?.trim();
	if (workspaceId) {
		attachmentEntries.push(...(await resolveStoredAttachmentEntries(workspaceId, input.attachments ?? [])));
	}
	const inlineImages = input.images?.filter((image) => image.data.trim().length > 0) ?? [];
	if (inlineImages.length > 0) {
		attachmentEntries.push(...(await materializeInlineImageEntries(inlineImages)));
	}
	if (attachmentEntries.length === 0) {
		return input.prompt;
	}
	const promptFormat =
		attachmentEntries.length === inlineImages.length && attachmentEntries.every((entry) => entry.kind === "image")
			? "images"
			: "attachments";
	return buildTaskPromptWithAttachmentPaths(input.prompt, attachmentEntries, promptFormat);
}
