import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

function canAccessPath(path: string): boolean {
	try {
		accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function getWindowsExecutableCandidates(binary: string): string[] {
	const pathext = process.env.PATHEXT?.split(";").filter(Boolean) ?? [".COM", ".EXE", ".BAT", ".CMD"];
	const lowerBinary = binary.toLowerCase();
	if (pathext.some((extension) => lowerBinary.endsWith(extension.toLowerCase()))) {
		return [binary];
	}
	return [binary, ...pathext.map((extension) => `${binary}${extension}`)];
}

function compareVersionSegments(left: string, right: string): number {
	const leftSegments = left.split(".");
	const rightSegments = right.split(".");
	const maxLength = Math.max(leftSegments.length, rightSegments.length);

	for (let index = 0; index < maxLength; index += 1) {
		const leftSegment = leftSegments[index] ?? "0";
		const rightSegment = rightSegments[index] ?? "0";
		const leftNumber = Number.parseInt(leftSegment, 10);
		const rightNumber = Number.parseInt(rightSegment, 10);
		const bothNumeric = Number.isFinite(leftNumber) && Number.isFinite(rightNumber);

		if (bothNumeric && leftNumber !== rightNumber) {
			return leftNumber - rightNumber;
		}
		if (bothNumeric) {
			continue;
		}

		const lexicalComparison = leftSegment.localeCompare(rightSegment);
		if (lexicalComparison !== 0) {
			return lexicalComparison;
		}
	}

	return 0;
}

function resolveClaudeDesktopBinaryPath(): string | null {
	if (process.platform !== "darwin") {
		return null;
	}

	const versionsRoot = join(homedir(), "Library", "Application Support", "Claude", "claude-code-vm");
	let versionDirectories: string[];
	try {
		versionDirectories = readdirSync(versionsRoot).filter((entry) => {
			try {
				return statSync(join(versionsRoot, entry)).isDirectory();
			} catch {
				return false;
			}
		});
	} catch {
		return null;
	}

	const sortedVersions = [...versionDirectories].sort((left, right) => compareVersionSegments(right, left));
	for (const version of sortedVersions) {
		const candidate = join(versionsRoot, version, "claude");
		if (canAccessPath(candidate)) {
			return candidate;
		}
	}

	return null;
}

function resolveKnownBinaryLocation(binary: string): string | null {
	if (binary === "claude") {
		return resolveClaudeDesktopBinaryPath();
	}
	return null;
}

// Intentionally resolve agent binaries in-process instead of spawning `which`, `where`,
// `command -v`, or an interactive shell.
//
// Why this exists:
// Kanban is launched from the user's shell and inherits that shell's environment, including
// PATH and exported variables. For agent detection and other startup-time capability checks,
// the question we care about is "can the current Kanban process directly execute this binary
// right now?" We answer that by checking PATH plus a small set of known app-managed install
// locations that provide directly executable binaries without requiring shell bootstrap.
//
// Why we do not delegate to shell commands:
// 1. Spawning helper commands like `which` or `where` adds unnecessary subprocess overhead
//    to hot paths such as loading runtime config.
// 2. Falling back to `zsh -ic 'command -v ...'` or similar is much worse because it can
//    trigger full interactive shell startup. On machines with heavy shell init like `conda`
//    or `nvm`, doing that repeatedly per task or per config read can freeze the runtime and
//    even make new terminal windows feel hung while the machine is saturated.
// 3. Depending on external lookup commands is also less robust than inspecting PATH directly.
//    For example, detection should not depend on `which` itself being available on PATH.
//
// Why this is acceptable:
// If a binary is only available after re-running shell init files, Kanban should still treat
// it as unavailable for task-agent startup. The only fallback we allow is a direct executable
// path in a known install location, because the Kanban process can launch that binary without
// relying on hidden shell side effects.
export function resolveBinaryLocation(binary: string): string | null {
	const trimmed = binary.trim();
	if (!trimmed) {
		return null;
	}
	if (trimmed.includes("/") || trimmed.includes("\\")) {
		return canAccessPath(trimmed) ? trimmed : null;
	}

	const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
	if (pathEntries.length > 0) {
		if (process.platform === "win32") {
			const candidates = getWindowsExecutableCandidates(trimmed);
			for (const entry of pathEntries) {
				for (const candidate of candidates) {
					const resolved = join(entry, candidate);
					if (canAccessPath(resolved)) {
						return resolved;
					}
				}
			}
		} else {
			for (const entry of pathEntries) {
				const resolved = join(entry, trimmed);
				if (canAccessPath(resolved)) {
					return resolved;
				}
			}
		}
	}

	return resolveKnownBinaryLocation(trimmed);
}

export function isBinaryAvailableOnPath(binary: string): boolean {
	return resolveBinaryLocation(binary) !== null;
}
