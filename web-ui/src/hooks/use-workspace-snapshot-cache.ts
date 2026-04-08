import { useCallback, useEffect, useRef } from "react";

import type { RuntimeWorkspaceMetadata, RuntimeWorkspaceStateResponse } from "@/runtime/types";

const MAX_CACHED_WORKSPACES = 5;

export interface CachedWorkspaceSnapshot {
	workspaceState: RuntimeWorkspaceStateResponse;
	workspaceMetadata: RuntimeWorkspaceMetadata | null;
	cachedAt: number;
}

export interface UseWorkspaceSnapshotCacheResult {
	getCachedWorkspaceSnapshot: (workspaceId: string | null | undefined) => CachedWorkspaceSnapshot | null;
}

export function useWorkspaceSnapshotCache(input: {
	currentProjectId: string | null;
	workspaceState: RuntimeWorkspaceStateResponse | null;
	workspaceMetadata: RuntimeWorkspaceMetadata | null;
}): UseWorkspaceSnapshotCacheResult {
	const cacheRef = useRef<Map<string, CachedWorkspaceSnapshot>>(new Map());

	useEffect(() => {
		if (!input.currentProjectId || !input.workspaceState) {
			return;
		}
		const nextCache = new Map(cacheRef.current);
		nextCache.delete(input.currentProjectId);
		nextCache.set(input.currentProjectId, {
			workspaceState: input.workspaceState,
			workspaceMetadata: input.workspaceMetadata,
			cachedAt: Date.now(),
		});
		while (nextCache.size > MAX_CACHED_WORKSPACES) {
			const oldestKey = nextCache.keys().next().value;
			if (typeof oldestKey !== "string") {
				break;
			}
			nextCache.delete(oldestKey);
		}
		cacheRef.current = nextCache;
	}, [input.currentProjectId, input.workspaceMetadata, input.workspaceState]);

	const getCachedWorkspaceSnapshot = useCallback((workspaceId: string | null | undefined) => {
		if (!workspaceId) {
			return null;
		}
		const cached = cacheRef.current.get(workspaceId) ?? null;
		if (!cached) {
			return null;
		}
		const nextCache = new Map(cacheRef.current);
		nextCache.delete(workspaceId);
		nextCache.set(workspaceId, cached);
		cacheRef.current = nextCache;
		return cached;
	}, []);

	return {
		getCachedWorkspaceSnapshot,
	};
}
