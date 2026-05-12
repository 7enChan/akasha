import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { CURRENT_AKASHA_EVENT_VERSION } from "./schema.js";
import { type AkashaTaskModel, buildAkashaTaskModel } from "./task-model.js";
import { type AkashaTemporalState, buildTemporalState } from "./temporal-state.js";
import type { AkashaEvent, AkashaStore } from "./types.js";
import { type AkashaProjectState, buildProjectState } from "./world-model.js";

export const AKASHA_PROJECTION_CACHE_VERSION = 1 as const;

export type AkashaProjectionCacheScope = "session" | "project" | "user";
export type AkashaProjectionCacheStatus = "fresh" | "missing" | "stale" | "invalid";

export interface AkashaProjectionSourceFingerprint {
	path: string;
	exists: boolean;
	size: number;
	mtimeMs: number;
}

export interface AkashaProjectionHighWaterMark {
	eventCount: number;
	lastSequence?: number;
	lastEventId?: string;
	lastEventTime?: string;
}

export interface AkashaProjectionCacheMetadata {
	scope: AkashaProjectionCacheScope;
	cacheKey: string;
	projectionVersion: typeof AKASHA_PROJECTION_CACHE_VERSION;
	eventSchemaVersion: typeof CURRENT_AKASHA_EVENT_VERSION;
	sourceLogPaths: string[];
	sourceFingerprints: AkashaProjectionSourceFingerprint[];
	highWaterMark: AkashaProjectionHighWaterMark;
	createdTime: string;
	updatedTime: string;
}

export interface AkashaProjectionCacheRecord<T> {
	metadata: AkashaProjectionCacheMetadata;
	value: T;
}

export interface AkashaProjectionCacheFreshness {
	status: AkashaProjectionCacheStatus;
	cachePath: string;
	reasons: string[];
	metadata?: AkashaProjectionCacheMetadata;
}

export interface AkashaProjectionCacheOptions {
	agentDir: string;
	eventLogDir?: string;
	cacheDir?: string;
	scope: AkashaProjectionCacheScope;
	cacheKey: string;
	sourceLogPaths: string[];
}

export interface AkashaTemporalStateSnapshot {
	temporal: AkashaTemporalState;
	project: AkashaProjectState;
	taskModel: AkashaTaskModel;
}

export interface AkashaCachedProjectionResult<T> {
	value: T;
	freshness: AkashaProjectionCacheFreshness;
	rebuilt: boolean;
}

export function resolveAkashaProjectionCacheDir(options: {
	agentDir: string;
	eventLogDir?: string;
	cacheDir?: string;
}): string {
	if (options.cacheDir)
		return isAbsolute(options.cacheDir) ? options.cacheDir : resolve(options.agentDir, options.cacheDir);
	return join(options.agentDir, "akasha", "projections");
}

export function resolveAkashaProjectionCachePath(options: AkashaProjectionCacheOptions): string {
	return join(resolveAkashaProjectionCacheDir(options), `${options.scope}-${hashCacheKey(options.cacheKey)}.json`);
}

export function sessionStateProjectionCacheKey(store: AkashaStore, limit: number): string {
	return `session-state:${store.eventLogPath}:${limit}`;
}

export function getAkashaProjectionCacheFreshness(
	options: AkashaProjectionCacheOptions,
): AkashaProjectionCacheFreshness {
	const cachePath = resolveAkashaProjectionCachePath(options);
	if (!existsSync(cachePath)) {
		return { status: "missing", cachePath, reasons: ["cache file does not exist"] };
	}

	const record = readAkashaProjectionCache<unknown>(cachePath);
	if (!record) return { status: "invalid", cachePath, reasons: ["cache file is not readable"] };
	const reasons = validateCacheRecord(record, options);
	return {
		status: reasons.length === 0 ? "fresh" : "stale",
		cachePath,
		reasons,
		metadata: record.metadata,
	};
}

export function readFreshAkashaProjectionCache<T>(
	options: AkashaProjectionCacheOptions,
): AkashaCachedProjectionResult<T> | undefined {
	const freshness = getAkashaProjectionCacheFreshness(options);
	if (freshness.status !== "fresh") return undefined;
	const record = readAkashaProjectionCache<T>(freshness.cachePath);
	if (!record) return undefined;
	return {
		value: record.value,
		freshness,
		rebuilt: false,
	};
}

export function writeAkashaProjectionCache<T>(
	options: AkashaProjectionCacheOptions,
	value: T,
	events: AkashaEvent[],
): AkashaCachedProjectionResult<T> {
	const cachePath = resolveAkashaProjectionCachePath(options);
	mkdirSync(resolveAkashaProjectionCacheDir(options), { recursive: true });
	const previous = readAkashaProjectionCache<T>(cachePath);
	const now = new Date().toISOString();
	const record: AkashaProjectionCacheRecord<T> = {
		metadata: {
			scope: options.scope,
			cacheKey: options.cacheKey,
			projectionVersion: AKASHA_PROJECTION_CACHE_VERSION,
			eventSchemaVersion: CURRENT_AKASHA_EVENT_VERSION,
			sourceLogPaths: normalizeSourcePaths(options.sourceLogPaths),
			sourceFingerprints: fingerprintSourcePaths(options.sourceLogPaths),
			highWaterMark: highWaterMark(events),
			createdTime: previous?.metadata.createdTime ?? now,
			updatedTime: now,
		},
		value,
	};
	writeJsonAtomically(cachePath, record);
	return {
		value,
		freshness: {
			status: "fresh",
			cachePath,
			reasons: [],
			metadata: record.metadata,
		},
		rebuilt: true,
	};
}

export function loadOrBuildAkashaProjection<T>(
	options: AkashaProjectionCacheOptions,
	build: () => { value: T; events: AkashaEvent[] },
): AkashaCachedProjectionResult<T> {
	const fresh = readFreshAkashaProjectionCache<T>(options);
	if (fresh) return fresh;
	const built = build();
	return writeAkashaProjectionCache(options, built.value, built.events);
}

export function buildCachedAkashaTemporalStateSnapshot(
	store: AkashaStore,
	options: {
		agentDir: string;
		eventLogDir?: string;
		limit?: number;
	},
): AkashaCachedProjectionResult<AkashaTemporalStateSnapshot> {
	const limit = options.limit ?? 1000;
	return loadOrBuildAkashaProjection(
		{
			agentDir: options.agentDir,
			eventLogDir: options.eventLogDir,
			scope: "session",
			cacheKey: sessionStateProjectionCacheKey(store, limit),
			sourceLogPaths: [store.eventLogPath],
		},
		() => {
			const events = store.buildTimeline({ limit });
			return {
				events,
				value: {
					temporal: buildTemporalState(events),
					project: buildProjectState(events),
					taskModel: buildAkashaTaskModel(events),
				},
			};
		},
	);
}

function readAkashaProjectionCache<T>(cachePath: string): AkashaProjectionCacheRecord<T> | undefined {
	try {
		const parsed = JSON.parse(readFileSync(cachePath, "utf-8")) as unknown;
		if (!isRecord(parsed) || !isRecord(parsed.metadata) || !("value" in parsed)) return undefined;
		return parsed as unknown as AkashaProjectionCacheRecord<T>;
	} catch {
		return undefined;
	}
}

function validateCacheRecord(
	record: AkashaProjectionCacheRecord<unknown>,
	options: AkashaProjectionCacheOptions,
): string[] {
	const reasons: string[] = [];
	if (record.metadata.scope !== options.scope) reasons.push("cache scope differs");
	if (record.metadata.cacheKey !== options.cacheKey) reasons.push("cache key differs");
	if (record.metadata.projectionVersion !== AKASHA_PROJECTION_CACHE_VERSION) {
		reasons.push("projection cache version changed");
	}
	if (record.metadata.eventSchemaVersion !== CURRENT_AKASHA_EVENT_VERSION) {
		reasons.push("event schema version changed");
	}

	const expectedPaths = normalizeSourcePaths(options.sourceLogPaths);
	if (record.metadata.sourceLogPaths.join("\n") !== expectedPaths.join("\n")) {
		reasons.push("source log paths changed");
	}

	const currentFingerprints = fingerprintSourcePaths(options.sourceLogPaths);
	if (JSON.stringify(record.metadata.sourceFingerprints) !== JSON.stringify(currentFingerprints)) {
		reasons.push("source log fingerprint changed");
	}
	return reasons;
}

function fingerprintSourcePaths(paths: string[]): AkashaProjectionSourceFingerprint[] {
	return normalizeSourcePaths(paths).map((path) => {
		try {
			const stat = statSync(path);
			return {
				path,
				exists: true,
				size: stat.size,
				mtimeMs: Math.trunc(stat.mtimeMs),
			};
		} catch {
			return {
				path,
				exists: false,
				size: 0,
				mtimeMs: 0,
			};
		}
	});
}

function highWaterMark(events: AkashaEvent[]): AkashaProjectionHighWaterMark {
	const last = events.at(-1);
	return {
		eventCount: events.length,
		lastSequence: last?.sequence,
		lastEventId: last?.eventId,
		lastEventTime: last?.eventTime,
	};
}

function normalizeSourcePaths(paths: string[]): string[] {
	return [...new Set(paths.map((path) => resolve(path)))].sort();
}

function hashCacheKey(cacheKey: string): string {
	return createHash("sha256").update(cacheKey).digest("hex").slice(0, 24);
}

function writeJsonAtomically(path: string, value: unknown): void {
	const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(tempPath, `${JSON.stringify(value)}\n`, "utf-8");
		renameSync(tempPath, path);
	} catch (error) {
		try {
			unlinkSync(tempPath);
		} catch {
			// best-effort cleanup
		}
		throw error;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
