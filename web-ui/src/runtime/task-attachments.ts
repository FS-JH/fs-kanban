import type {
	RuntimeTaskAttachment,
	RuntimeTaskAttachmentUploadRequest,
	RuntimeTaskAttachmentUploadResponse,
} from "@/runtime/types";

const ATTACHMENT_UPLOAD_ENDPOINT = "/api/attachments/upload";
const ATTACHMENT_FILE_ENDPOINT = "/api/attachments/file";

function buildWorkspaceScopedAttachmentUrl(pathname: string, workspaceId: string, storageKey?: string): string {
	const searchParams = new URLSearchParams({ workspaceId });
	if (storageKey) {
		searchParams.set("storageKey", storageKey);
	}
	return `${pathname}?${searchParams.toString()}`;
}

async function fileToBase64(file: File): Promise<string> {
	return await new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const result = reader.result;
			if (typeof result !== "string") {
				reject(new Error("Could not read attachment file."));
				return;
			}
			const dataBase64 = result.split(",")[1];
			if (!dataBase64) {
				reject(new Error("Could not encode attachment file."));
				return;
			}
			resolve(dataBase64);
		};
		reader.onerror = () => reject(reader.error ?? new Error("Could not read attachment file."));
		reader.readAsDataURL(file);
	});
}

export function buildTaskAttachmentPreviewUrl(
	workspaceId: string,
	attachment: Pick<RuntimeTaskAttachment, "storageKey">,
): string | null {
	const storageKey = attachment.storageKey.trim();
	if (!storageKey) {
		return null;
	}
	return buildWorkspaceScopedAttachmentUrl(ATTACHMENT_FILE_ENDPOINT, workspaceId, storageKey);
}

export async function buildTaskAttachmentUploadRequest(file: File): Promise<RuntimeTaskAttachmentUploadRequest> {
	return {
		name: file.name || "attachment",
		mimeType: file.type || "application/octet-stream",
		dataBase64: await fileToBase64(file),
	};
}

export async function uploadTaskAttachment(workspaceId: string, file: File): Promise<RuntimeTaskAttachment> {
	const requestBody = await buildTaskAttachmentUploadRequest(file);
	const response = await fetch(buildWorkspaceScopedAttachmentUrl(ATTACHMENT_UPLOAD_ENDPOINT, workspaceId), {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify(requestBody),
	});
	const payload = (await response.json()) as RuntimeTaskAttachmentUploadResponse;
	if (!response.ok || !payload.ok || !payload.attachment) {
		throw new Error(payload.error ?? "Attachment upload failed.");
	}
	return payload.attachment;
}
