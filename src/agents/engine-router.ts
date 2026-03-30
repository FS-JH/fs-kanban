import { ClaudeCliEngineAdapter } from "./claude-adapter.js";
import { CodexCliEngineAdapter } from "./codex-adapter.js";
import type { EngineAdapter, EngineResult, ProviderProbe } from "./engine-adapter.js";

export const DEFAULT_ROLE_ORDER = [
	"supervisor",
	"planner",
	"implementer",
	"reviewer",
	"tester",
	"security",
	"reporter",
] as const;

export type EngineRole = (typeof DEFAULT_ROLE_ORDER)[number];
export type EngineProviderId = "codex_cli" | "claude_cli";

export interface ProviderRuntimeStatus {
	providerId: string;
	available: boolean;
	binary: string;
	authState: string;
	cooldownUntil: number;
	detail: string;
}

export interface EngineRouterConfig {
	providers?: Partial<Record<EngineProviderId, { binary?: string; enabled?: boolean }>>;
	roleRoutes?: Partial<Record<EngineRole, string[] | string | { primary?: string; fallback?: string[] | string }>>;
	providerFallbackOrder?: string[];
	providerCooldownSeconds?: number;
}

export interface EngineRouterRunOptions {
	role: EngineRole | string;
	taskId?: string;
	prompt: string;
	cwd: string;
	timeoutSeconds?: number;
	outputSchema?: Record<string, unknown> | null;
	onStdout?: (chunk: string) => void;
	disallowProviders?: Set<string>;
	forceProvider?: string;
}

export class EngineRouter {
	private readonly providers: Map<string, EngineAdapter>;
	private readonly roleRoutes: Map<string, string[]>;
	private readonly providerFallbackOrder: string[];
	private readonly cooldownSeconds: number;
	private readonly cooldownUntil = new Map<string, number>();

	constructor(input: {
		providers: Record<string, EngineAdapter>;
		roleRoutes?: Partial<Record<EngineRole, string[]>>;
		providerFallbackOrder?: string[];
		cooldownSeconds?: number;
	}) {
		this.providers = new Map(Object.entries(input.providers));
		this.roleRoutes = new Map(Object.entries(input.roleRoutes ?? {}));
		this.providerFallbackOrder = dedupeStrings(input.providerFallbackOrder ?? ["codex_cli", "claude_cli"]);
		this.cooldownSeconds = Math.max(1, input.cooldownSeconds ?? 60);
	}

	static fromConfig(config: EngineRouterConfig = {}): EngineRouter {
		const providers: Record<string, EngineAdapter> = {
			codex_cli: new CodexCliEngineAdapter({
				binary: config.providers?.codex_cli?.binary,
				enableDangerousAutonomy: Boolean(config.providers?.codex_cli?.enabled),
			}),
			claude_cli: new ClaudeCliEngineAdapter({
				binary: config.providers?.claude_cli?.binary,
				enableDangerousPermissions: Boolean(config.providers?.claude_cli?.enabled),
			}),
		};

		const normalizedRoutes: Partial<Record<EngineRole, string[]>> = {};
		for (const role of DEFAULT_ROLE_ORDER) {
			const raw = config.roleRoutes?.[role];
			if (!raw) {
				normalizedRoutes[role] = ["codex_cli", "claude_cli"];
				continue;
			}
			if (Array.isArray(raw)) {
				normalizedRoutes[role] = dedupeStrings(raw);
				continue;
			}
			if (typeof raw === "string") {
				normalizedRoutes[role] = dedupeStrings([raw]);
				continue;
			}
			const routes: string[] = [];
			if (typeof raw.primary === "string" && raw.primary.trim()) {
				routes.push(raw.primary.trim());
			}
			const fallback = raw.fallback;
			if (Array.isArray(fallback)) {
				routes.push(...fallback.map((entry) => entry.trim()).filter(Boolean));
			} else if (typeof fallback === "string" && fallback.trim()) {
				routes.push(fallback.trim());
			}
			normalizedRoutes[role] = dedupeStrings(routes.length > 0 ? routes : ["codex_cli", "claude_cli"]);
		}

		return new EngineRouter({
			providers,
			roleRoutes: normalizedRoutes,
			providerFallbackOrder: config.providerFallbackOrder,
			cooldownSeconds: config.providerCooldownSeconds,
		});
	}

	get anyAvailable(): boolean {
		for (const provider of this.providers.values()) {
			if (provider.available) {
				return true;
			}
		}
		return false;
	}

	terminateActive(): void {
		for (const provider of this.providers.values()) {
			provider.terminateActive();
		}
	}

	providerStatuses(): ProviderRuntimeStatus[] {
		const now = Date.now();
		return Array.from(this.providers.entries())
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([providerId, provider]) => {
				const probe: ProviderProbe = provider.probe();
				return {
					providerId,
					available: Boolean(probe.available),
					binary: probe.binary,
					authState: probe.authState,
					cooldownUntil: Math.max(0, (this.cooldownUntil.get(providerId) ?? 0) - now),
					detail: probe.detail,
				};
			});
	}

	async runForRole(options: EngineRouterRunOptions): Promise<EngineResult> {
		const candidates = options.forceProvider
			? [options.forceProvider]
			: this.candidateOrder(options.role);
		const blocked = options.disallowProviders ?? new Set<string>();
		let lastResult: EngineResult | null = null;

		for (const providerId of candidates) {
			if (blocked.has(providerId)) {
				continue;
			}
			if (this.onCooldown(providerId)) {
				continue;
			}
			const provider = this.providers.get(providerId);
			if (!provider || !provider.available) {
				continue;
			}
			const result = await provider.run({
				taskId: options.taskId?.trim() || this.buildTaskIdFromRole(options.role),
				prompt: options.prompt,
				cwd: options.cwd,
				timeoutSeconds: options.timeoutSeconds,
				outputSchema: options.outputSchema,
				onStdout: options.onStdout,
			});
			if (result.ok) {
				return result;
			}
			if (this.shouldCooldown(result)) {
				this.markCooldown(providerId);
			}
			lastResult = result;
		}

		if (lastResult) {
			return lastResult;
		}
		return {
			ok: false,
			rawOutput: "",
			parsed: {},
			error: "engine_unavailable",
			timedOut: false,
			provider: options.forceProvider ?? "",
			exitCode: 127,
		};
	}

	private buildTaskIdFromRole(role: string): string {
		return `role-${role}`;
	}

	private candidateOrder(role: string): string[] {
		const routes = [...(this.roleRoutes.get(role) ?? [])];
		if (routes.length === 0) {
			routes.push("codex_cli");
		}
		for (const providerId of this.providerFallbackOrder) {
			if (!routes.includes(providerId)) {
				routes.push(providerId);
			}
		}
		return dedupeStrings(routes);
	}

	private onCooldown(providerId: string): boolean {
		return (this.cooldownUntil.get(providerId) ?? 0) > Date.now();
	}

	private markCooldown(providerId: string): void {
		this.cooldownUntil.set(providerId, Date.now() + this.cooldownSeconds * 1000);
	}

	private shouldCooldown(result: EngineResult): boolean {
		const error = (result.error ?? "").trim().toLowerCase();
		return result.timedOut || error === "timeout" || error === "rate_limited" || error === "provider_unavailable";
	}
}

function dedupeStrings(values: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		const normalized = value.trim();
		if (!normalized || seen.has(normalized)) {
			continue;
		}
		seen.add(normalized);
		result.push(normalized);
	}
	return result;
}
