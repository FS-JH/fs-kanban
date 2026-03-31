export interface ToolCallDisplay {
	toolName: string;
	inputSummary: string | null;
}

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxLength = 80): string {
	if (value.length <= maxLength) {
		return value;
	}
	return `${value.slice(0, maxLength - 1)}…`;
}

function formatReadFilesSummary(parsed: unknown): string | null {
	const toRange = (file: Record<string, unknown>): string | null => {
		const path = typeof file.path === "string" ? file.path : typeof file.filePath === "string" ? file.filePath : null;
		if (!path) {
			return null;
		}
		const start = typeof file.start_line === "number" ? file.start_line : 1;
		const end = typeof file.end_line === "number" ? file.end_line : start;
		const hasRange = "start_line" in file || "end_line" in file;
		return hasRange ? `${path}:${start}-${end}` : path;
	};

	if (Array.isArray(parsed)) {
		const paths = parsed.filter((value): value is string => typeof value === "string");
		return paths.length > 0 ? paths.join(", ") : null;
	}
	if (!parsed || typeof parsed !== "object") {
		return null;
	}
	const record = parsed as Record<string, unknown>;
	if (Array.isArray(record.file_paths)) {
		const paths = record.file_paths.filter((value): value is string => typeof value === "string");
		return paths.length > 0 ? paths.join(", ") : null;
	}
	if (Array.isArray(record.files)) {
		const files = record.files
			.filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null)
			.map(toRange)
			.filter((value): value is string => Boolean(value));
		return files.length > 0 ? files.join(", ") : null;
	}
	return null;
}

function formatFetchWebSummary(parsed: unknown): string | null {
	if (!parsed || typeof parsed !== "object") {
		return null;
	}
	const requests = (parsed as { requests?: unknown }).requests;
	if (!Array.isArray(requests) || requests.length === 0) {
		return null;
	}
	const urls = requests
		.map((request) =>
			typeof request === "object" && request !== null && typeof (request as { url?: unknown }).url === "string"
				? (request as { url: string }).url
				: null,
		)
		.filter((value): value is string => Boolean(value));
	if (urls.length === 0) {
		return null;
	}
	const firstUrl = urls[0] ?? null;
	if (!firstUrl) {
		return null;
	}
	return urls.length === 1 ? firstUrl : `${firstUrl} (+${urls.length - 1} more)`;
}

function readInputSummary(input: unknown, toolName: string): string | null {
	if (input == null) {
		return null;
	}
	let parsed: unknown = input;
	if (typeof input === "string") {
		try {
			parsed = JSON.parse(input) as unknown;
		} catch {
			return truncate(normalizeWhitespace(input));
		}
	}

	const normalizedToolName = toolName.toLowerCase().replace(/[^a-z_]/g, "");
	if (normalizedToolName === "fetch_web_content") {
		return formatFetchWebSummary(parsed);
	}
	if (normalizedToolName === "read_files" || normalizedToolName === "readfiles") {
		return formatReadFilesSummary(parsed);
	}
	if (typeof parsed === "string") {
		return truncate(normalizeWhitespace(parsed));
	}
	if (Array.isArray(parsed)) {
		return parsed.length > 0 ? truncate(normalizeWhitespace(JSON.stringify(parsed[0]))) : null;
	}
	if (parsed && typeof parsed === "object") {
		const firstValue = Object.values(parsed as Record<string, unknown>).find((value) => value != null);
		if (typeof firstValue === "string") {
			return truncate(normalizeWhitespace(firstValue));
		}
		if (firstValue !== undefined) {
			return truncate(normalizeWhitespace(JSON.stringify(firstValue)));
		}
	}
	return null;
}

export function getToolCallDisplay(toolName: string, input: unknown): ToolCallDisplay {
	const inputSummary = readInputSummary(input, toolName);
	return {
		toolName,
		inputSummary,
	};
}

export function formatToolCallLabel(toolName: string, inputSummary: string | null): string {
	return inputSummary ? `${toolName}: ${inputSummary}` : toolName;
}
