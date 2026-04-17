const MAX_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024;
const ACCEPTED_ATTACHMENT_TYPES = [
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"application/pdf",
	"application/msword",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"text/plain",
	"text/markdown",
	"application/json",
	"text/csv",
] as const;
const ACCEPTED_ATTACHMENT_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".doc", ".docx", ".txt", ".md", ".json", ".csv"] as const;
const ACCEPTED_ATTACHMENT_TYPE_SET = new Set<string>(ACCEPTED_ATTACHMENT_TYPES);

export const ACCEPTED_TASK_ATTACHMENT_INPUT_ACCEPT = [
	...ACCEPTED_ATTACHMENT_TYPES,
	...ACCEPTED_ATTACHMENT_EXTENSIONS,
].join(",");

function hasAcceptedTaskAttachmentExtension(fileName: string): boolean {
	const normalizedFileName = fileName.trim().toLowerCase();
	return ACCEPTED_ATTACHMENT_EXTENSIONS.some((extension) => normalizedFileName.endsWith(extension));
}

export function isAcceptedTaskAttachmentFile(file: File): boolean {
	return (
		file.size > 0 &&
		file.size <= MAX_ATTACHMENT_SIZE_BYTES &&
		(ACCEPTED_ATTACHMENT_TYPE_SET.has(file.type) || hasAcceptedTaskAttachmentExtension(file.name))
	);
}

export function collectAttachmentFilesFromDataTransfer(dataTransfer: DataTransfer): File[] {
	const files: File[] = [];
	if (dataTransfer.items && dataTransfer.items.length > 0) {
		for (let i = 0; i < dataTransfer.items.length; i += 1) {
			const item = dataTransfer.items[i];
			if (!item || item.kind !== "file") {
				continue;
			}
			const file = item.getAsFile();
			if (file && isAcceptedTaskAttachmentFile(file)) {
				files.push(file);
			}
		}
	}
	if (files.length === 0) {
		for (const file of Array.from(dataTransfer.files)) {
			if (isAcceptedTaskAttachmentFile(file)) {
				files.push(file);
			}
		}
	}
	return files;
}
