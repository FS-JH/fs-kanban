import type { Dirent } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

import type { RuntimeBoardData, RuntimeTaskAttachment, RuntimeTaskAttachmentKind } from "../core/api-contract.js";

const MAX_TASK_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const STALE_UNREFERENCED_ATTACHMENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const EXTRACTED_TEXT_SIDECAR_SUFFIX = ".extracted.txt";
export const TASK_ATTACHMENTS_DIRECTORY_NAME = "attachments";
const MIME_TYPE_EXTENSION_BY_VALUE: Record<string, string> = {
	"application/json": ".json",
	"application/pdf": ".pdf",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
	"application/msword": ".doc",
	"text/csv": ".csv",
	"text/markdown": ".md",
	"text/plain": ".txt",
	"image/gif": ".gif",
	"image/jpeg": ".jpg",
	"image/png": ".png",
	"image/svg+xml": ".svg",
	"image/webp": ".webp",
};
const EXTENSION_CONTENT_TYPE_BY_VALUE: Record<string, string> = Object.fromEntries(
	Object.entries(MIME_TYPE_EXTENSION_BY_VALUE).map(([mimeType, extension]) => [extension, mimeType]),
);

export interface StoreTaskAttachmentInput {
	name: string;
	mimeType: string;
	dataBase64: string;
}

function sanitizeTaskAttachmentName(value: string): string {
	const normalized = value.normalize("NFKD").replaceAll(/[^A-Za-z0-9._-]+/g, "-");
	const trimmed = normalized.replaceAll(/^-+|-+$/g, "");
	return trimmed.length > 0 ? trimmed : "attachment";
}

function detectTaskAttachmentKind(name: string, mimeType: string): RuntimeTaskAttachmentKind {
	const normalizedMimeType = mimeType.trim().toLowerCase();
	if (normalizedMimeType.startsWith("image/")) {
		return "image";
	}
	if (
		normalizedMimeType.startsWith("text/") ||
		normalizedMimeType === "application/json" ||
		normalizedMimeType === "application/xml"
	) {
		return "text";
	}
	if (
		normalizedMimeType.includes("csv") ||
		normalizedMimeType.includes("spreadsheet") ||
		normalizedMimeType.includes("excel")
	) {
		return "data";
	}
	if (
		normalizedMimeType === "application/pdf" ||
		normalizedMimeType.includes("wordprocessingml") ||
		normalizedMimeType.includes("msword")
	) {
		return "document";
	}
	const normalizedExtension = extname(name).trim().toLowerCase();
	if (normalizedExtension === ".md" || normalizedExtension === ".txt" || normalizedExtension === ".json") {
		return "text";
	}
	if (normalizedExtension === ".csv") {
		return "data";
	}
	if (normalizedExtension === ".pdf" || normalizedExtension === ".doc" || normalizedExtension === ".docx") {
		return "document";
	}
	return "other";
}

function resolveTaskAttachmentExtension(name: string, mimeType: string): string {
	const existingExtension = extname(name).toLowerCase();
	if (existingExtension) {
		return existingExtension;
	}
	return MIME_TYPE_EXTENSION_BY_VALUE[mimeType.trim().toLowerCase()] ?? "";
}

function buildStoredTaskAttachmentFileName(id: string, name: string, mimeType: string): string {
	const extension = resolveTaskAttachmentExtension(name, mimeType);
	const baseName = basename(name, extname(name));
	return `${id}-${sanitizeTaskAttachmentName(baseName)}${extension}`;
}

function decodeTaskAttachmentBase64(dataBase64: string): Buffer {
	try {
		return Buffer.from(dataBase64, "base64");
	} catch {
		throw new Error("Attachment payload is not valid base64.");
	}
}

async function removePathIfExists(path: string): Promise<void> {
	await rm(path, { force: true });
}

function resolveAttachmentPath(rootPath: string, storageKey: string): string {
	const trimmedKey = storageKey.trim();
	if (!trimmedKey || trimmedKey.includes("/") || trimmedKey.includes("\\")) {
		throw new Error("Invalid attachment storage key.");
	}
	const resolvedRoot = resolve(rootPath);
	const resolvedPath = resolve(resolvedRoot, trimmedKey);
	if (resolvedPath !== join(resolvedRoot, trimmedKey)) {
		throw new Error("Invalid attachment path.");
	}
	return resolvedPath;
}

function getExtractedTextSidecarPath(attachmentPath: string): string {
	return `${attachmentPath}${EXTRACTED_TEXT_SIDECAR_SUFFIX}`;
}

export function getTaskAttachmentsRootPath(workspaceDirectoryPath: string): string {
	return join(workspaceDirectoryPath, TASK_ATTACHMENTS_DIRECTORY_NAME);
}

export function isTaskAttachmentTextLike(attachment: Pick<RuntimeTaskAttachment, "kind" | "mimeType" | "name">): boolean {
	if (attachment.kind === "text" || attachment.kind === "data") {
		return true;
	}
	const normalizedMimeType = attachment.mimeType.trim().toLowerCase();
	if (
		normalizedMimeType.startsWith("text/") ||
		normalizedMimeType === "application/json" ||
		normalizedMimeType === "application/xml"
	) {
		return true;
	}
	const normalizedExtension = extname(attachment.name).trim().toLowerCase();
	return normalizedExtension === ".md" || normalizedExtension === ".txt" || normalizedExtension === ".json";
}

export function isTaskAttachmentDocumentLike(
	attachment: Pick<RuntimeTaskAttachment, "kind" | "mimeType" | "name">,
): boolean {
	if (attachment.kind === "document") {
		return true;
	}
	const normalizedMimeType = attachment.mimeType.trim().toLowerCase();
	if (
		normalizedMimeType === "application/pdf" ||
		normalizedMimeType.includes("wordprocessingml") ||
		normalizedMimeType.includes("msword")
	) {
		return true;
	}
	const normalizedExtension = extname(attachment.name).trim().toLowerCase();
	return normalizedExtension === ".pdf" || normalizedExtension === ".doc" || normalizedExtension === ".docx";
}

export function lookupTaskAttachmentContentType(
	attachment: Pick<RuntimeTaskAttachment, "mimeType" | "name">,
): string {
	const normalizedMimeType = attachment.mimeType.trim();
	if (normalizedMimeType) {
		return normalizedMimeType;
	}
	const extension = extname(attachment.name).toLowerCase();
	return EXTENSION_CONTENT_TYPE_BY_VALUE[extension] ?? "application/octet-stream";
}

export async function storeTaskAttachment(
	rootPath: string,
	input: StoreTaskAttachmentInput,
): Promise<RuntimeTaskAttachment> {
	const name = input.name.trim();
	const mimeType = input.mimeType.trim();
	if (!name) {
		throw new Error("Attachment name cannot be empty.");
	}
	if (!mimeType) {
		throw new Error("Attachment MIME type cannot be empty.");
	}
	const data = decodeTaskAttachmentBase64(input.dataBase64.trim());
	if (data.byteLength === 0) {
		throw new Error("Attachment payload cannot be empty.");
	}
	if (data.byteLength > MAX_TASK_ATTACHMENT_BYTES) {
		throw new Error(`Attachment exceeds the ${MAX_TASK_ATTACHMENT_BYTES} byte limit.`);
	}

	await mkdir(rootPath, { recursive: true });
	const id = randomUUID().replaceAll("-", "").slice(0, 12);
	const storageKey = buildStoredTaskAttachmentFileName(id, name, mimeType);
	const filePath = resolveAttachmentPath(rootPath, storageKey);
	const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`;
	await writeFile(tempPath, data);
	await rename(tempPath, filePath);

	return {
		id,
		kind: detectTaskAttachmentKind(name, mimeType),
		name,
		mimeType,
		sizeBytes: data.byteLength,
		storageKey,
	};
}

export function resolveStoredTaskAttachmentPath(rootPath: string, storageKey: string): string {
	return resolveAttachmentPath(rootPath, storageKey);
}

export async function resolveExistingStoredTaskAttachmentPath(
	rootPath: string,
	storageKey: string,
): Promise<string | null> {
	const filePath = resolveAttachmentPath(rootPath, storageKey);
	try {
		await stat(filePath);
		return filePath;
	} catch {
		return null;
	}
}

export function collectBoardAttachmentStorageKeys(board: RuntimeBoardData): Set<string> {
	const storageKeys = new Set<string>();
	for (const column of board.columns) {
		for (const card of column.cards) {
			for (const attachment of card.attachments ?? []) {
				const storageKey = attachment.storageKey.trim();
				if (storageKey) {
					storageKeys.add(storageKey);
				}
			}
		}
	}
	return storageKeys;
}

export async function deleteTaskAttachmentsByStorageKey(
	rootPath: string,
	storageKeys: Iterable<string>,
): Promise<void> {
	for (const storageKey of storageKeys) {
		const trimmedKey = storageKey.trim();
		if (!trimmedKey) {
			continue;
		}
		const attachmentPath = resolveAttachmentPath(rootPath, trimmedKey);
		await removePathIfExists(attachmentPath);
		await removePathIfExists(getExtractedTextSidecarPath(attachmentPath));
	}
}

export async function deleteRemovedBoardAttachments(
	rootPath: string,
	previousBoard: RuntimeBoardData,
	nextBoard: RuntimeBoardData,
): Promise<void> {
	const previousKeys = collectBoardAttachmentStorageKeys(previousBoard);
	const nextKeys = collectBoardAttachmentStorageKeys(nextBoard);
	const removedKeys = Array.from(previousKeys).filter((storageKey) => !nextKeys.has(storageKey));
	if (removedKeys.length === 0) {
		return;
	}
	await deleteTaskAttachmentsByStorageKey(rootPath, removedKeys);
}

export async function pruneStaleUnreferencedTaskAttachments(
	rootPath: string,
	referencedStorageKeys: Set<string>,
	maxAgeMs = STALE_UNREFERENCED_ATTACHMENT_MAX_AGE_MS,
): Promise<void> {
	let entries: Dirent[];
	try {
		entries = await readdir(rootPath, { withFileTypes: true });
	} catch {
		return;
	}
	const now = Date.now();
	for (const entry of entries) {
		if (!entry.isFile()) {
			continue;
		}
		const entryName = entry.name;
		const baseStorageKey = entryName.endsWith(EXTRACTED_TEXT_SIDECAR_SUFFIX)
			? entryName.slice(0, -EXTRACTED_TEXT_SIDECAR_SUFFIX.length)
			: entryName;
		if (referencedStorageKeys.has(baseStorageKey)) {
			continue;
		}
		const attachmentPath = resolveAttachmentPath(rootPath, entryName);
		let ageMs = Number.POSITIVE_INFINITY;
		try {
			const stats = await stat(attachmentPath);
			ageMs = now - stats.mtimeMs;
		} catch {
			continue;
		}
		if (ageMs < maxAgeMs) {
			continue;
		}
		await removePathIfExists(attachmentPath);
	}
}
