import { type AkashaMemoryTrace, buildAkashaMemoryTraces } from "./memory-trace.js";
import { type AkashaCachedProjectionResult, loadOrBuildAkashaProjection } from "./projection-cache.js";
import type { AkashaStore } from "./types.js";

export function memoryTraceProjectionCacheKey(store: AkashaStore, limit: number): string {
	return `memory-traces:${store.eventLogPath}:${limit}`;
}

export function buildCachedAkashaMemoryTraces(
	store: AkashaStore,
	options: {
		agentDir: string;
		eventLogDir?: string;
		cacheDir?: string;
		limit?: number;
		fingerprintMode?: "fast" | "strong";
	},
): AkashaCachedProjectionResult<AkashaMemoryTrace[]> {
	const limit = options.limit ?? 1000;
	return loadOrBuildAkashaProjection(
		{
			agentDir: options.agentDir,
			eventLogDir: options.eventLogDir,
			cacheDir: options.cacheDir,
			scope: "session",
			cacheKey: memoryTraceProjectionCacheKey(store, limit),
			sourceLogPaths: [store.eventLogPath],
			fingerprintMode: options.fingerprintMode,
		},
		() => {
			const events = store.buildTimeline({ limit });
			return {
				events,
				value: buildAkashaMemoryTraces(events),
			};
		},
	);
}
