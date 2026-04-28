// Persists FS Kanban-owned runtime preferences on disk.
// This module should store board settings such as selected agents,
// shortcuts, and prompt templates, not SDK-owned secrets or OAuth data.
import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isRuntimeAgentLaunchSupported } from "../core/agent-catalog.js";
import type { RuntimeAgentApprovalMode, RuntimeAgentId, RuntimeProjectShortcut } from "../core/api-contract.js";
import { type LockRequest, lockedFileSystem } from "../fs/locked-file-system.js";
import { detectInstalledCommands } from "../terminal/agent-registry.js";
import { areRuntimeProjectShortcutsEqual } from "./shortcut-utils.js";

interface RuntimeGlobalConfigFileShape {
	selectedAgentId?: RuntimeAgentId;
	fallbackAgentId?: RuntimeAgentId | null;
	selectedShortcutLabel?: string;
	agentApprovalMode?: RuntimeAgentApprovalMode;
	agentAutonomousModeEnabled?: boolean;
	agentAttentionNotificationsEnabled?: boolean;
	agentAttentionSoundEnabled?: boolean;
	readyForReviewNotificationsEnabled?: boolean;
	commitPromptTemplate?: string;
	openPrPromptTemplate?: string;
}

interface RuntimeProjectConfigFileShape {
	shortcuts?: RuntimeProjectShortcut[];
}

export interface RuntimeConfigState {
	globalConfigPath: string;
	projectConfigPath: string | null;
	selectedAgentId: RuntimeAgentId;
	fallbackAgentId: RuntimeAgentId | null;
	selectedShortcutLabel: string | null;
	agentApprovalMode: RuntimeAgentApprovalMode;
	agentAutonomousModeEnabled: boolean;
	agentAttentionNotificationsEnabled: boolean;
	agentAttentionSoundEnabled: boolean;
	readyForReviewNotificationsEnabled: boolean;
	shortcuts: RuntimeProjectShortcut[];
	commitPromptTemplate: string;
	openPrPromptTemplate: string;
	commitPromptTemplateDefault: string;
	openPrPromptTemplateDefault: string;
}

export interface RuntimeConfigUpdateInput {
	selectedAgentId?: RuntimeAgentId;
	fallbackAgentId?: RuntimeAgentId | null;
	selectedShortcutLabel?: string | null;
	agentApprovalMode?: RuntimeAgentApprovalMode;
	agentAutonomousModeEnabled?: boolean;
	agentAttentionNotificationsEnabled?: boolean;
	agentAttentionSoundEnabled?: boolean;
	readyForReviewNotificationsEnabled?: boolean;
	shortcuts?: RuntimeProjectShortcut[];
	commitPromptTemplate?: string;
	openPrPromptTemplate?: string;
}

const RUNTIME_HOME_PARENT_DIR = ".config";
const RUNTIME_HOME_DIR = "fs-kanban";
const CONFIG_FILENAME = "config.json";
const PROJECT_CONFIG_PARENT_DIR = ".fs-kanban";
const PROJECT_CONFIG_DIR = "";
const PROJECT_CONFIG_FILENAME = "config.json";
const DEFAULT_AGENT_ID: RuntimeAgentId = "codex";
const AUTO_SELECT_AGENT_PRIORITY: readonly RuntimeAgentId[] = ["codex", "claude"];
const DEFAULT_AGENT_APPROVAL_MODE: RuntimeAgentApprovalMode = "full_auto";
const DEFAULT_AGENT_ATTENTION_NOTIFICATIONS_ENABLED = true;
const DEFAULT_AGENT_ATTENTION_SOUND_ENABLED = false;
const DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED = true;
const DEFAULT_COMMIT_PROMPT_TEMPLATE = `You are in a worktree on a detached HEAD. When you are finished with the task, commit the working changes onto {{base_ref}}.

- Do not run destructive commands: git reset --hard, git clean -fdx, git worktree remove, rm/mv on repository paths.
- Do not edit files outside git workflows unless required for conflict resolution.
- Preserve any pre-existing user uncommitted changes in the base worktree.

Steps:
1. In the current task worktree, stage and create a commit for the pending task changes.
2. Find where {{base_ref}} is checked out:
   - Run: git worktree list --porcelain
   - If branch {{base_ref}} is checked out in path P, use that P.
   - If not checked out anywhere, use current worktree as P by checking out {{base_ref}} there.
3. In P, verify current branch is {{base_ref}}.
4. If P has uncommitted changes, stash them: git -C P stash push -u -m "kanban-pre-cherry-pick"
5. Cherry-pick the task commit into P.
6. If cherry-pick conflicts, resolve carefully, preserving both the intended task changes and existing user edits.
7. If a stash was created, restore it with: git -C P stash pop
8. If stash pop conflicts, resolve them while preserving pre-existing user edits.
9. Report:
   - Final commit hash
   - Final commit message
   - Whether stash was used
   - Whether conflicts were resolved
   - Any remaining manual follow-up needed`;
const DEFAULT_OPEN_PR_PROMPT_TEMPLATE = `You are in a worktree on a detached HEAD. When you are finished with the task, open a pull request against {{base_ref}}.

- Do not run destructive commands: git reset --hard, git clean -fdx, git worktree remove, rm/mv on repository paths.
- Do not modify the base worktree.
- Keep all PR preparation in the current task worktree.

Steps:
1. Ensure all intended changes are committed in the current task worktree.
2. If currently on detached HEAD, create a branch at the current commit in this worktree.
3. Push the branch to origin and set upstream.
4. Create a pull request with base {{base_ref}} and head as the pushed branch (use gh CLI if available).
5. If a pull request already exists for the same head and base, return that existing PR URL instead of creating a duplicate.
6. If PR creation is blocked, explain exactly why and provide the exact commands to complete it manually.
7. Report:
   - PR title: PR URL
   - Base branch
   - Head branch
   - Any follow-up needed`;

export function pickBestInstalledAgentIdFromDetected(detectedCommands: readonly string[]): RuntimeAgentId | null {
	const detected = new Set(detectedCommands);
	for (const agentId of AUTO_SELECT_AGENT_PRIORITY) {
		if (detected.has(agentId)) {
			return agentId;
		}
	}
	return null;
}

function getRuntimeHomePath(): string {
	return join(homedir(), RUNTIME_HOME_PARENT_DIR, RUNTIME_HOME_DIR);
}

function normalizeAgentId(agentId: RuntimeAgentId | string | null | undefined): RuntimeAgentId {
	if ((agentId === "claude" || agentId === "codex") && isRuntimeAgentLaunchSupported(agentId)) {
		return agentId;
	}
	return DEFAULT_AGENT_ID;
}

function normalizeFallbackAgentId(
	agentId: RuntimeAgentId | string | null | undefined,
	selectedAgentId: RuntimeAgentId,
): RuntimeAgentId | null {
	if (agentId !== "claude" && agentId !== "codex") {
		return null;
	}
	if (!isRuntimeAgentLaunchSupported(agentId) || agentId === selectedAgentId) {
		return null;
	}
	return agentId;
}

function pickBestInstalledAgentId(): RuntimeAgentId | null {
	return pickBestInstalledAgentIdFromDetected(detectInstalledCommands());
}

function normalizeShortcut(shortcut: RuntimeProjectShortcut): RuntimeProjectShortcut | null {
	if (!shortcut || typeof shortcut !== "object") {
		return null;
	}

	const label = typeof shortcut.label === "string" ? shortcut.label.trim() : "";
	const command = typeof shortcut.command === "string" ? shortcut.command.trim() : "";
	const icon = typeof shortcut.icon === "string" ? shortcut.icon.trim() : "";

	if (!label || !command) {
		return null;
	}

	return {
		label,
		command,
		icon: icon || undefined,
	};
}

function normalizeShortcuts(shortcuts: RuntimeProjectShortcut[] | null | undefined): RuntimeProjectShortcut[] {
	if (!Array.isArray(shortcuts)) {
		return [];
	}
	const normalized: RuntimeProjectShortcut[] = [];
	for (const shortcut of shortcuts) {
		const parsed = normalizeShortcut(shortcut);
		if (parsed) {
			normalized.push(parsed);
		}
	}
	return normalized;
}

function normalizePromptTemplate(value: unknown, fallback: string): string {
	if (typeof value !== "string") {
		return fallback;
	}
	const normalized = value.trim();
	return normalized.length > 0 ? value : fallback;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") {
		return value;
	}
	return fallback;
}

function normalizeApprovalMode(value: unknown, fallback: RuntimeAgentApprovalMode): RuntimeAgentApprovalMode {
	if (value === "manual" || value === "supervised" || value === "full_auto") {
		return value;
	}
	return fallback;
}

function resolveApprovalMode(
	value: unknown,
	legacyAutonomousModeEnabled: unknown,
	fallback: RuntimeAgentApprovalMode,
): RuntimeAgentApprovalMode {
	if (value === "manual" || value === "supervised" || value === "full_auto") {
		return value;
	}
	if (typeof legacyAutonomousModeEnabled === "boolean") {
		return legacyAutonomousModeEnabled ? "full_auto" : "manual";
	}
	return fallback;
}

function isFullAutoApprovalMode(mode: RuntimeAgentApprovalMode): boolean {
	return mode === "full_auto";
}

function normalizeShortcutLabel(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

function hasOwnKey<T extends object>(value: T | null, key: keyof T): boolean {
	if (!value) {
		return false;
	}
	return Object.hasOwn(value, key);
}

export function getRuntimeGlobalConfigPath(): string {
	return join(getRuntimeHomePath(), CONFIG_FILENAME);
}

export function getRuntimeProjectConfigPath(cwd: string): string {
	return join(resolve(cwd), PROJECT_CONFIG_PARENT_DIR, PROJECT_CONFIG_DIR, PROJECT_CONFIG_FILENAME);
}

interface RuntimeConfigPaths {
	globalConfigPath: string;
	projectConfigPath: string | null;
}

function normalizePathForComparison(path: string): string {
	const normalized = resolve(path).replaceAll("\\", "/");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function resolveRuntimeConfigPaths(cwd: string | null): RuntimeConfigPaths {
	const globalConfigPath = getRuntimeGlobalConfigPath();
	if (cwd === null) {
		return {
			globalConfigPath,
			projectConfigPath: null,
		};
	}

	const normalizedCwd = normalizePathForComparison(cwd);
	const normalizedHome = normalizePathForComparison(homedir());
	if (normalizedCwd === normalizedHome) {
		return {
			globalConfigPath,
			projectConfigPath: null,
		};
	}

	return {
		globalConfigPath,
		projectConfigPath: getRuntimeProjectConfigPath(cwd),
	};
}

function getRuntimeConfigLockRequests(cwd: string | null): LockRequest[] {
	const paths = resolveRuntimeConfigPaths(cwd);
	const requests: LockRequest[] = [
		{
			path: paths.globalConfigPath,
			type: "file",
		},
	];
	if (paths.projectConfigPath) {
		requests.push({
			path: paths.projectConfigPath,
			type: "file",
		});
	}
	return requests;
}

function toRuntimeConfigState({
	globalConfigPath,
	projectConfigPath,
	globalConfig,
	projectConfig,
}: {
	globalConfigPath: string;
	projectConfigPath: string | null;
	globalConfig: RuntimeGlobalConfigFileShape | null;
	projectConfig: RuntimeProjectConfigFileShape | null;
}): RuntimeConfigState {
	return {
		globalConfigPath,
		projectConfigPath,
		selectedAgentId: normalizeAgentId(globalConfig?.selectedAgentId),
		fallbackAgentId: normalizeFallbackAgentId(
			globalConfig?.fallbackAgentId,
			normalizeAgentId(globalConfig?.selectedAgentId),
		),
		selectedShortcutLabel: normalizeShortcutLabel(globalConfig?.selectedShortcutLabel),
		agentApprovalMode: resolveApprovalMode(
			globalConfig?.agentApprovalMode,
			globalConfig?.agentAutonomousModeEnabled,
			DEFAULT_AGENT_APPROVAL_MODE,
		),
		agentAutonomousModeEnabled: isFullAutoApprovalMode(
			resolveApprovalMode(
				globalConfig?.agentApprovalMode,
				globalConfig?.agentAutonomousModeEnabled,
				DEFAULT_AGENT_APPROVAL_MODE,
			),
		),
		agentAttentionNotificationsEnabled: normalizeBoolean(
			globalConfig?.agentAttentionNotificationsEnabled,
			DEFAULT_AGENT_ATTENTION_NOTIFICATIONS_ENABLED,
		),
		agentAttentionSoundEnabled: normalizeBoolean(
			globalConfig?.agentAttentionSoundEnabled,
			DEFAULT_AGENT_ATTENTION_SOUND_ENABLED,
		),
		readyForReviewNotificationsEnabled: normalizeBoolean(
			globalConfig?.readyForReviewNotificationsEnabled,
			DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED,
		),
		shortcuts: normalizeShortcuts(projectConfig?.shortcuts),
		commitPromptTemplate: normalizePromptTemplate(globalConfig?.commitPromptTemplate, DEFAULT_COMMIT_PROMPT_TEMPLATE),
		openPrPromptTemplate: normalizePromptTemplate(
			globalConfig?.openPrPromptTemplate,
			DEFAULT_OPEN_PR_PROMPT_TEMPLATE,
		),
		commitPromptTemplateDefault: DEFAULT_COMMIT_PROMPT_TEMPLATE,
		openPrPromptTemplateDefault: DEFAULT_OPEN_PR_PROMPT_TEMPLATE,
	};
}

async function readRuntimeConfigFile<T>(configPath: string): Promise<T | null> {
	try {
		const raw = await readFile(configPath, "utf8");
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

async function writeRuntimeGlobalConfigFile(
	configPath: string,
	config: {
		selectedAgentId?: RuntimeAgentId;
		fallbackAgentId?: RuntimeAgentId | null;
		selectedShortcutLabel?: string | null;
		agentApprovalMode?: RuntimeAgentApprovalMode;
		agentAutonomousModeEnabled?: boolean;
		agentAttentionNotificationsEnabled?: boolean;
		agentAttentionSoundEnabled?: boolean;
		readyForReviewNotificationsEnabled?: boolean;
		commitPromptTemplate?: string;
		openPrPromptTemplate?: string;
	},
): Promise<void> {
	const existing = await readRuntimeConfigFile<RuntimeGlobalConfigFileShape>(configPath);
	const selectedAgentId = config.selectedAgentId === undefined ? undefined : normalizeAgentId(config.selectedAgentId);
	const existingSelectedAgentId = hasOwnKey(existing, "selectedAgentId")
		? normalizeAgentId(existing?.selectedAgentId)
		: undefined;
	const nextSelectedAgentId = selectedAgentId ?? existingSelectedAgentId ?? DEFAULT_AGENT_ID;
	const fallbackAgentId =
		config.fallbackAgentId === undefined
			? undefined
			: normalizeFallbackAgentId(config.fallbackAgentId, nextSelectedAgentId);
	const existingFallbackAgentId = hasOwnKey(existing, "fallbackAgentId")
		? normalizeFallbackAgentId(existing?.fallbackAgentId, nextSelectedAgentId)
		: undefined;
	const selectedShortcutLabel =
		config.selectedShortcutLabel === undefined ? undefined : normalizeShortcutLabel(config.selectedShortcutLabel);
	const existingSelectedShortcutLabel = hasOwnKey(existing, "selectedShortcutLabel")
		? normalizeShortcutLabel(existing?.selectedShortcutLabel)
		: undefined;
	const existingAgentApprovalMode =
		hasOwnKey(existing, "agentApprovalMode") || hasOwnKey(existing, "agentAutonomousModeEnabled")
			? resolveApprovalMode(
					existing?.agentApprovalMode,
					existing?.agentAutonomousModeEnabled,
					DEFAULT_AGENT_APPROVAL_MODE,
				)
			: undefined;
	const agentApprovalMode =
		config.agentApprovalMode === undefined && config.agentAutonomousModeEnabled === undefined
			? (existingAgentApprovalMode ?? DEFAULT_AGENT_APPROVAL_MODE)
			: resolveApprovalMode(
					config.agentApprovalMode,
					config.agentAutonomousModeEnabled,
					DEFAULT_AGENT_APPROVAL_MODE,
				);
	const agentAttentionNotificationsEnabled =
		config.agentAttentionNotificationsEnabled === undefined
			? DEFAULT_AGENT_ATTENTION_NOTIFICATIONS_ENABLED
			: normalizeBoolean(config.agentAttentionNotificationsEnabled, DEFAULT_AGENT_ATTENTION_NOTIFICATIONS_ENABLED);
	const agentAttentionSoundEnabled =
		config.agentAttentionSoundEnabled === undefined
			? DEFAULT_AGENT_ATTENTION_SOUND_ENABLED
			: normalizeBoolean(config.agentAttentionSoundEnabled, DEFAULT_AGENT_ATTENTION_SOUND_ENABLED);
	const readyForReviewNotificationsEnabled =
		config.readyForReviewNotificationsEnabled === undefined
			? DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED
			: normalizeBoolean(config.readyForReviewNotificationsEnabled, DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED);
	const commitPromptTemplate =
		config.commitPromptTemplate === undefined
			? DEFAULT_COMMIT_PROMPT_TEMPLATE
			: normalizePromptTemplate(config.commitPromptTemplate, DEFAULT_COMMIT_PROMPT_TEMPLATE);
	const openPrPromptTemplate =
		config.openPrPromptTemplate === undefined
			? DEFAULT_OPEN_PR_PROMPT_TEMPLATE
			: normalizePromptTemplate(config.openPrPromptTemplate, DEFAULT_OPEN_PR_PROMPT_TEMPLATE);

	const payload: RuntimeGlobalConfigFileShape = {};
	if (selectedAgentId !== undefined) {
		if (hasOwnKey(existing, "selectedAgentId") || selectedAgentId !== DEFAULT_AGENT_ID) {
			payload.selectedAgentId = selectedAgentId;
		}
	} else if (existingSelectedAgentId !== undefined) {
		payload.selectedAgentId = existingSelectedAgentId;
	}
	if (fallbackAgentId !== undefined) {
		if (fallbackAgentId !== null) {
			payload.fallbackAgentId = fallbackAgentId;
		}
	} else if (existingFallbackAgentId !== undefined && existingFallbackAgentId !== null) {
		payload.fallbackAgentId = existingFallbackAgentId;
	}
	if (selectedShortcutLabel !== undefined) {
		if (selectedShortcutLabel) {
			payload.selectedShortcutLabel = selectedShortcutLabel;
		}
	} else if (existingSelectedShortcutLabel) {
		payload.selectedShortcutLabel = existingSelectedShortcutLabel;
	}
	if (
		hasOwnKey(existing, "agentApprovalMode") ||
		hasOwnKey(existing, "agentAutonomousModeEnabled") ||
		agentApprovalMode !== DEFAULT_AGENT_APPROVAL_MODE
	) {
		payload.agentApprovalMode = agentApprovalMode;
	}
	if (
		hasOwnKey(existing, "agentAttentionNotificationsEnabled") ||
		agentAttentionNotificationsEnabled !== DEFAULT_AGENT_ATTENTION_NOTIFICATIONS_ENABLED
	) {
		payload.agentAttentionNotificationsEnabled = agentAttentionNotificationsEnabled;
	}
	if (
		hasOwnKey(existing, "agentAttentionSoundEnabled") ||
		agentAttentionSoundEnabled !== DEFAULT_AGENT_ATTENTION_SOUND_ENABLED
	) {
		payload.agentAttentionSoundEnabled = agentAttentionSoundEnabled;
	}
	if (
		hasOwnKey(existing, "readyForReviewNotificationsEnabled") ||
		readyForReviewNotificationsEnabled !== DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED
	) {
		payload.readyForReviewNotificationsEnabled = readyForReviewNotificationsEnabled;
	}
	if (hasOwnKey(existing, "commitPromptTemplate") || commitPromptTemplate !== DEFAULT_COMMIT_PROMPT_TEMPLATE) {
		payload.commitPromptTemplate = commitPromptTemplate;
	}
	if (hasOwnKey(existing, "openPrPromptTemplate") || openPrPromptTemplate !== DEFAULT_OPEN_PR_PROMPT_TEMPLATE) {
		payload.openPrPromptTemplate = openPrPromptTemplate;
	}

	await lockedFileSystem.writeJsonFileAtomic(configPath, payload, {
		lock: null,
	});
}

async function writeRuntimeProjectConfigFile(
	configPath: string | null,
	config: { shortcuts: RuntimeProjectShortcut[] },
): Promise<void> {
	const normalizedShortcuts = normalizeShortcuts(config.shortcuts);
	if (!configPath) {
		if (normalizedShortcuts.length > 0) {
			throw new Error("Cannot save project shortcuts without a selected project.");
		}
		return;
	}
	if (normalizedShortcuts.length === 0) {
		await rm(configPath, { force: true });
		try {
			await rm(dirname(configPath));
		} catch {
			// Ignore missing or non-empty project config directories.
		}
		return;
	}
	await lockedFileSystem.writeJsonFileAtomic(
		configPath,
		{
			shortcuts: normalizedShortcuts,
		} satisfies RuntimeProjectConfigFileShape,
		{
			lock: null,
		},
	);
}

interface RuntimeConfigFiles {
	globalConfigPath: string;
	projectConfigPath: string | null;
	globalConfig: RuntimeGlobalConfigFileShape | null;
	projectConfig: RuntimeProjectConfigFileShape | null;
}

async function readRuntimeConfigFiles(cwd: string | null): Promise<RuntimeConfigFiles> {
	const { globalConfigPath, projectConfigPath } = resolveRuntimeConfigPaths(cwd);
	return {
		globalConfigPath,
		projectConfigPath,
		globalConfig: await readRuntimeConfigFile<RuntimeGlobalConfigFileShape>(globalConfigPath),
		projectConfig: projectConfigPath
			? await readRuntimeConfigFile<RuntimeProjectConfigFileShape>(projectConfigPath)
			: null,
	};
}

async function loadRuntimeConfigLocked(cwd: string | null): Promise<RuntimeConfigState> {
	const configFiles = await readRuntimeConfigFiles(cwd);
	if (configFiles.globalConfig === null) {
		const autoSelectedAgentId = pickBestInstalledAgentId();
		if (autoSelectedAgentId) {
			await writeRuntimeGlobalConfigFile(configFiles.globalConfigPath, {
				selectedAgentId: autoSelectedAgentId,
			});
			configFiles.globalConfig = {
				selectedAgentId: autoSelectedAgentId,
			};
		}
	}
	return toRuntimeConfigState(configFiles);
}

function createRuntimeConfigStateFromValues(input: {
	globalConfigPath: string;
	projectConfigPath: string | null;
	selectedAgentId: RuntimeAgentId;
	fallbackAgentId: RuntimeAgentId | null;
	selectedShortcutLabel: string | null;
	agentApprovalMode: RuntimeAgentApprovalMode;
	agentAttentionNotificationsEnabled: boolean;
	agentAttentionSoundEnabled: boolean;
	readyForReviewNotificationsEnabled: boolean;
	shortcuts: RuntimeProjectShortcut[];
	commitPromptTemplate: string;
	openPrPromptTemplate: string;
}): RuntimeConfigState {
	return {
		globalConfigPath: input.globalConfigPath,
		projectConfigPath: input.projectConfigPath,
		selectedAgentId: normalizeAgentId(input.selectedAgentId),
		fallbackAgentId: normalizeFallbackAgentId(input.fallbackAgentId, normalizeAgentId(input.selectedAgentId)),
		selectedShortcutLabel: normalizeShortcutLabel(input.selectedShortcutLabel),
		agentApprovalMode: normalizeApprovalMode(input.agentApprovalMode, DEFAULT_AGENT_APPROVAL_MODE),
		agentAutonomousModeEnabled: isFullAutoApprovalMode(
			normalizeApprovalMode(input.agentApprovalMode, DEFAULT_AGENT_APPROVAL_MODE),
		),
		agentAttentionNotificationsEnabled: normalizeBoolean(
			input.agentAttentionNotificationsEnabled,
			DEFAULT_AGENT_ATTENTION_NOTIFICATIONS_ENABLED,
		),
		agentAttentionSoundEnabled: normalizeBoolean(
			input.agentAttentionSoundEnabled,
			DEFAULT_AGENT_ATTENTION_SOUND_ENABLED,
		),
		readyForReviewNotificationsEnabled: normalizeBoolean(
			input.readyForReviewNotificationsEnabled,
			DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED,
		),
		shortcuts: normalizeShortcuts(input.shortcuts),
		commitPromptTemplate: normalizePromptTemplate(input.commitPromptTemplate, DEFAULT_COMMIT_PROMPT_TEMPLATE),
		openPrPromptTemplate: normalizePromptTemplate(input.openPrPromptTemplate, DEFAULT_OPEN_PR_PROMPT_TEMPLATE),
		commitPromptTemplateDefault: DEFAULT_COMMIT_PROMPT_TEMPLATE,
		openPrPromptTemplateDefault: DEFAULT_OPEN_PR_PROMPT_TEMPLATE,
	};
}

export function toGlobalRuntimeConfigState(current: RuntimeConfigState): RuntimeConfigState {
	return createRuntimeConfigStateFromValues({
		globalConfigPath: current.globalConfigPath,
		projectConfigPath: null,
		selectedAgentId: current.selectedAgentId,
		fallbackAgentId: current.fallbackAgentId,
		selectedShortcutLabel: current.selectedShortcutLabel,
		agentApprovalMode: current.agentApprovalMode,
		agentAttentionNotificationsEnabled: current.agentAttentionNotificationsEnabled,
		agentAttentionSoundEnabled: current.agentAttentionSoundEnabled,
		readyForReviewNotificationsEnabled: current.readyForReviewNotificationsEnabled,
		shortcuts: [],
		commitPromptTemplate: current.commitPromptTemplate,
		openPrPromptTemplate: current.openPrPromptTemplate,
	});
}

export async function loadRuntimeConfig(cwd: string): Promise<RuntimeConfigState> {
	const configFiles = await readRuntimeConfigFiles(cwd);
	if (configFiles.globalConfig !== null) {
		return toRuntimeConfigState(configFiles);
	}
	return await lockedFileSystem.withLocks(
		getRuntimeConfigLockRequests(cwd),
		async () => await loadRuntimeConfigLocked(cwd),
	);
}

export async function loadGlobalRuntimeConfig(): Promise<RuntimeConfigState> {
	const configFiles = await readRuntimeConfigFiles(null);
	if (configFiles.globalConfig !== null) {
		return toRuntimeConfigState(configFiles);
	}
	return await lockedFileSystem.withLocks(
		getRuntimeConfigLockRequests(null),
		async () => await loadRuntimeConfigLocked(null),
	);
}

export async function saveRuntimeConfig(
	cwd: string,
	config: {
		selectedAgentId: RuntimeAgentId;
		fallbackAgentId: RuntimeAgentId | null;
		selectedShortcutLabel: string | null;
		agentApprovalMode: RuntimeAgentApprovalMode;
		agentAttentionNotificationsEnabled: boolean;
		agentAttentionSoundEnabled: boolean;
		readyForReviewNotificationsEnabled: boolean;
		shortcuts: RuntimeProjectShortcut[];
		commitPromptTemplate: string;
		openPrPromptTemplate: string;
	},
): Promise<RuntimeConfigState> {
	const { globalConfigPath, projectConfigPath } = resolveRuntimeConfigPaths(cwd);
	return await lockedFileSystem.withLocks(getRuntimeConfigLockRequests(cwd), async () => {
		await writeRuntimeGlobalConfigFile(globalConfigPath, {
			selectedAgentId: config.selectedAgentId,
			fallbackAgentId: config.fallbackAgentId,
			selectedShortcutLabel: config.selectedShortcutLabel,
			agentApprovalMode: config.agentApprovalMode,
			agentAttentionNotificationsEnabled: config.agentAttentionNotificationsEnabled,
			agentAttentionSoundEnabled: config.agentAttentionSoundEnabled,
			readyForReviewNotificationsEnabled: config.readyForReviewNotificationsEnabled,
			commitPromptTemplate: config.commitPromptTemplate,
			openPrPromptTemplate: config.openPrPromptTemplate,
		});
		await writeRuntimeProjectConfigFile(projectConfigPath, { shortcuts: config.shortcuts });
		return createRuntimeConfigStateFromValues({
			globalConfigPath,
			projectConfigPath,
			selectedAgentId: config.selectedAgentId,
			fallbackAgentId: config.fallbackAgentId,
			selectedShortcutLabel: config.selectedShortcutLabel,
			agentApprovalMode: config.agentApprovalMode,
			agentAttentionNotificationsEnabled: config.agentAttentionNotificationsEnabled,
			agentAttentionSoundEnabled: config.agentAttentionSoundEnabled,
			readyForReviewNotificationsEnabled: config.readyForReviewNotificationsEnabled,
			shortcuts: config.shortcuts,
			commitPromptTemplate: config.commitPromptTemplate,
			openPrPromptTemplate: config.openPrPromptTemplate,
		});
	});
}

export async function updateRuntimeConfig(cwd: string, updates: RuntimeConfigUpdateInput): Promise<RuntimeConfigState> {
	const { globalConfigPath, projectConfigPath } = resolveRuntimeConfigPaths(cwd);
	return await lockedFileSystem.withLocks(getRuntimeConfigLockRequests(cwd), async () => {
		const current = await loadRuntimeConfigLocked(cwd);
		if (projectConfigPath === null && normalizeShortcuts(updates.shortcuts).length > 0) {
			throw new Error("Cannot save project shortcuts without a selected project.");
		}
		const nextConfig = {
			selectedAgentId: updates.selectedAgentId ?? current.selectedAgentId,
			fallbackAgentId:
				updates.fallbackAgentId === undefined
					? current.fallbackAgentId
					: normalizeFallbackAgentId(updates.fallbackAgentId, updates.selectedAgentId ?? current.selectedAgentId),
			selectedShortcutLabel:
				updates.selectedShortcutLabel === undefined ? current.selectedShortcutLabel : updates.selectedShortcutLabel,
			agentApprovalMode:
				updates.agentApprovalMode === undefined && updates.agentAutonomousModeEnabled === undefined
					? current.agentApprovalMode
					: resolveApprovalMode(
							updates.agentApprovalMode,
							updates.agentAutonomousModeEnabled,
							current.agentApprovalMode,
						),
			agentAttentionNotificationsEnabled:
				updates.agentAttentionNotificationsEnabled ?? current.agentAttentionNotificationsEnabled,
			agentAttentionSoundEnabled: updates.agentAttentionSoundEnabled ?? current.agentAttentionSoundEnabled,
			readyForReviewNotificationsEnabled:
				updates.readyForReviewNotificationsEnabled ?? current.readyForReviewNotificationsEnabled,
			shortcuts: projectConfigPath ? (updates.shortcuts ?? current.shortcuts) : current.shortcuts,
			commitPromptTemplate: updates.commitPromptTemplate ?? current.commitPromptTemplate,
			openPrPromptTemplate: updates.openPrPromptTemplate ?? current.openPrPromptTemplate,
		};

		const hasChanges =
			nextConfig.selectedAgentId !== current.selectedAgentId ||
			nextConfig.fallbackAgentId !== current.fallbackAgentId ||
			nextConfig.selectedShortcutLabel !== current.selectedShortcutLabel ||
			nextConfig.agentApprovalMode !== current.agentApprovalMode ||
			nextConfig.agentAttentionNotificationsEnabled !== current.agentAttentionNotificationsEnabled ||
			nextConfig.agentAttentionSoundEnabled !== current.agentAttentionSoundEnabled ||
			nextConfig.readyForReviewNotificationsEnabled !== current.readyForReviewNotificationsEnabled ||
			nextConfig.commitPromptTemplate !== current.commitPromptTemplate ||
			nextConfig.openPrPromptTemplate !== current.openPrPromptTemplate ||
			!areRuntimeProjectShortcutsEqual(nextConfig.shortcuts, current.shortcuts);

		if (!hasChanges) {
			return current;
		}

		await writeRuntimeGlobalConfigFile(globalConfigPath, {
			selectedAgentId: nextConfig.selectedAgentId,
			fallbackAgentId: nextConfig.fallbackAgentId,
			selectedShortcutLabel: nextConfig.selectedShortcutLabel,
			agentApprovalMode: nextConfig.agentApprovalMode,
			agentAttentionNotificationsEnabled: nextConfig.agentAttentionNotificationsEnabled,
			agentAttentionSoundEnabled: nextConfig.agentAttentionSoundEnabled,
			readyForReviewNotificationsEnabled: nextConfig.readyForReviewNotificationsEnabled,
			commitPromptTemplate: nextConfig.commitPromptTemplate,
			openPrPromptTemplate: nextConfig.openPrPromptTemplate,
		});
		await writeRuntimeProjectConfigFile(projectConfigPath, {
			shortcuts: nextConfig.shortcuts,
		});
		return createRuntimeConfigStateFromValues({
			globalConfigPath,
			projectConfigPath,
			selectedAgentId: nextConfig.selectedAgentId,
			fallbackAgentId: nextConfig.fallbackAgentId,
			selectedShortcutLabel: nextConfig.selectedShortcutLabel,
			agentApprovalMode: nextConfig.agentApprovalMode,
			agentAttentionNotificationsEnabled: nextConfig.agentAttentionNotificationsEnabled,
			agentAttentionSoundEnabled: nextConfig.agentAttentionSoundEnabled,
			readyForReviewNotificationsEnabled: nextConfig.readyForReviewNotificationsEnabled,
			shortcuts: nextConfig.shortcuts,
			commitPromptTemplate: nextConfig.commitPromptTemplate,
			openPrPromptTemplate: nextConfig.openPrPromptTemplate,
		});
	});
}

export async function updateGlobalRuntimeConfig(
	current: RuntimeConfigState,
	updates: RuntimeConfigUpdateInput,
): Promise<RuntimeConfigState> {
	const globalConfigPath = getRuntimeGlobalConfigPath();
	return await lockedFileSystem.withLocks(
		[
			{
				path: globalConfigPath,
				type: "file",
			},
		],
		async () => {
			const nextConfig = {
				selectedAgentId: updates.selectedAgentId ?? current.selectedAgentId,
				fallbackAgentId:
					updates.fallbackAgentId === undefined
						? current.fallbackAgentId
						: normalizeFallbackAgentId(
								updates.fallbackAgentId,
								updates.selectedAgentId ?? current.selectedAgentId,
							),
				selectedShortcutLabel:
					updates.selectedShortcutLabel === undefined
						? current.selectedShortcutLabel
						: updates.selectedShortcutLabel,
				agentApprovalMode:
					updates.agentApprovalMode === undefined && updates.agentAutonomousModeEnabled === undefined
						? current.agentApprovalMode
						: resolveApprovalMode(
								updates.agentApprovalMode,
								updates.agentAutonomousModeEnabled,
								current.agentApprovalMode,
							),
				agentAttentionNotificationsEnabled:
					updates.agentAttentionNotificationsEnabled ?? current.agentAttentionNotificationsEnabled,
				agentAttentionSoundEnabled: updates.agentAttentionSoundEnabled ?? current.agentAttentionSoundEnabled,
				readyForReviewNotificationsEnabled:
					updates.readyForReviewNotificationsEnabled ?? current.readyForReviewNotificationsEnabled,
				shortcuts: current.shortcuts,
				commitPromptTemplate: updates.commitPromptTemplate ?? current.commitPromptTemplate,
				openPrPromptTemplate: updates.openPrPromptTemplate ?? current.openPrPromptTemplate,
			};

			const hasChanges =
				nextConfig.selectedAgentId !== current.selectedAgentId ||
				nextConfig.fallbackAgentId !== current.fallbackAgentId ||
				nextConfig.selectedShortcutLabel !== current.selectedShortcutLabel ||
				nextConfig.agentApprovalMode !== current.agentApprovalMode ||
				nextConfig.agentAttentionNotificationsEnabled !== current.agentAttentionNotificationsEnabled ||
				nextConfig.agentAttentionSoundEnabled !== current.agentAttentionSoundEnabled ||
				nextConfig.readyForReviewNotificationsEnabled !== current.readyForReviewNotificationsEnabled ||
				nextConfig.commitPromptTemplate !== current.commitPromptTemplate ||
				nextConfig.openPrPromptTemplate !== current.openPrPromptTemplate;

			if (!hasChanges) {
				return current;
			}

			await writeRuntimeGlobalConfigFile(globalConfigPath, {
				selectedAgentId: nextConfig.selectedAgentId,
				fallbackAgentId: nextConfig.fallbackAgentId,
				selectedShortcutLabel: nextConfig.selectedShortcutLabel,
				agentApprovalMode: nextConfig.agentApprovalMode,
				agentAttentionNotificationsEnabled: nextConfig.agentAttentionNotificationsEnabled,
				agentAttentionSoundEnabled: nextConfig.agentAttentionSoundEnabled,
				readyForReviewNotificationsEnabled: nextConfig.readyForReviewNotificationsEnabled,
				commitPromptTemplate: nextConfig.commitPromptTemplate,
				openPrPromptTemplate: nextConfig.openPrPromptTemplate,
			});

			return createRuntimeConfigStateFromValues({
				globalConfigPath,
				projectConfigPath: current.projectConfigPath,
				selectedAgentId: nextConfig.selectedAgentId,
				fallbackAgentId: nextConfig.fallbackAgentId,
				selectedShortcutLabel: nextConfig.selectedShortcutLabel,
				agentApprovalMode: nextConfig.agentApprovalMode,
				agentAttentionNotificationsEnabled: nextConfig.agentAttentionNotificationsEnabled,
				agentAttentionSoundEnabled: nextConfig.agentAttentionSoundEnabled,
				readyForReviewNotificationsEnabled: nextConfig.readyForReviewNotificationsEnabled,
				shortcuts: nextConfig.shortcuts,
				commitPromptTemplate: nextConfig.commitPromptTemplate,
				openPrPromptTemplate: nextConfig.openPrPromptTemplate,
			});
		},
	);
}
