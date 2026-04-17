import type { RuntimeTaskImage } from "../core/api-contract.js";
import { prepareTaskPromptWithAttachments } from "./task-attachment-prompt.js";

export async function prepareTaskPromptWithImages(input: {
	prompt: string;
	images?: RuntimeTaskImage[];
}): Promise<string> {
	return await prepareTaskPromptWithAttachments({
		prompt: input.prompt,
		images: input.images,
	});
}
