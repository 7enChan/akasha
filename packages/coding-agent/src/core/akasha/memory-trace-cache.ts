import { type AkashaMemoryTrace, buildAkashaMemoryTraces } from "./memory-trace.js";
import {
	type AkashaCachedProjectionResult,
	type AkashaProjectionCacheScope,
	loadOrBuildAkashaProjection,
} from "./projection-cache.js";
import type { AkashaEvent, AkashaStore } from "./types.js";

export function memoryTraceProjectionCacheKey(store: AkashaStore, limit: number): string {
	return `memory-traces:${store.eventLogPath}:${limit}`;
}

export function memoryTraceProjectionCacheKeyForScope(scopeKey: string, limit: number): string {
	return `memory-traces:${scopeKey}:${limit}`;
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

export function buildCachedAkashaMemoryTracesFromEvents(
	events: AkashaEvent[],
	options: {
		agentDir: string;
		eventLogDir?: string;
		cacheDir?: string;
		scope: AkashaProjectionCacheScope;
		cacheKey: string;
		sourceLogPaths: string[];
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
			scope: options.scope,
			cacheKey: options.cacheKey,
			sourceLogPaths: options.sourceLogPaths,
			fingerprintMode: options.fingerprintMode,
		},
		() => {
			const limitedEvents = events.slice(-limit);
			return {
				events: limitedEvents,
				value: buildAkashaMemoryTraces(limitedEvents),
			};
		},
	);
}
