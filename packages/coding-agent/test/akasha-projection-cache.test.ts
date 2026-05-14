import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlAkashaStore } from "../src/core/akasha/jsonl-store.js";
import { buildAkashaMemoryTraces } from "../src/core/akasha/memory-trace.js";
import {
	buildCachedAkashaMemoryTraceEdgesFromEvents,
	memoryTraceEdgeProjectionCacheKeyForScope,
} from "../src/core/akasha/memory-trace-cache.js";
import { buildAkashaProjectTimeline } from "../src/core/akasha/project-timeline.js";
import {
	buildCachedAkashaTemporalStateSnapshot,
	getAkashaProjectionCacheFreshness,
	loadOrBuildAkashaProjection,
	sessionStateProjectionCacheKey,
} from "../src/core/akasha/projection-cache.js";

describe("Akasha projection cache", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "akasha-projection-cache-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("caches session temporal projections and reloads them while fresh", () => {
		const store = new JsonlAkashaStore(join(tempDir, "events", "session-1.jsonl"));
		store.append({
			kind: "message.user.submitted",
			sessionId: "session-1",
			streamId: "session:session-1",
			eventTime: "2026-05-12T00:00:00.000Z",
			actor: "user",
			payload: { text: "Implement projection cache" },
			ttlPolicy: "long_term",
		});

		const first = buildCachedAkashaTemporalStateSnapshot(store, { agentDir: tempDir, limit: 1000 });
		const second = buildCachedAkashaTemporalStateSnapshot(store, { agentDir: tempDir, limit: 1000 });

		expect(first.rebuilt).toBe(true);
		expect(second.rebuilt).toBe(false);
		expect(second.freshness.status).toBe("fresh");
		expect(second.value.taskModel.goals[0]?.text).toContain("projection cache");
		expect(existsSync(second.freshness.cachePath)).toBe(true);
	});

	it("invalidates stale cache when the source event log changes and rebuilds after deletion", () => {
		const store = new JsonlAkashaStore(join(tempDir, "events", "session-1.jsonl"));
		store.append({
			kind: "message.user.submitted",
			sessionId: "session-1",
			streamId: "session:session-1",
			eventTime: "2026-05-12T00:00:00.000Z",
			actor: "user",
			payload: { text: "Build M21" },
		});
		const first = buildCachedAkashaTemporalStateSnapshot(store, { agentDir: tempDir, limit: 1000 });
		store.append({
			kind: "message.agent.completed",
			sessionId: "session-1",
			streamId: "session:session-1",
			eventTime: "2026-05-12T00:01:00.000Z",
			actor: "agent",
			payload: { text: "I will use the cache after the log changes." },
		});

		const stale = getAkashaProjectionCacheFreshness({
			agentDir: tempDir,
			scope: "session",
			cacheKey: sessionStateProjectionCacheKey(store, 1000),
			sourceLogPaths: [store.eventLogPath],
		});
		const rebuilt = buildCachedAkashaTemporalStateSnapshot(store, { agentDir: tempDir, limit: 1000 });
		unlinkSync(rebuilt.freshness.cachePath);
		const rebuiltAfterDelete = buildCachedAkashaTemporalStateSnapshot(store, { agentDir: tempDir, limit: 1000 });

		expect(first.freshness.status).toBe("fresh");
		expect(stale.status).toBe("stale");
		expect(stale.reasons).toContain("source log fingerprint changed");
		expect(rebuilt.rebuilt).toBe(true);
		expect(rebuilt.value.taskModel.decisions[0]?.text).toContain("cache");
		expect(rebuiltAfterDelete.rebuilt).toBe(true);
	});

	it("caches trace edge projections and invalidates when source logs change", () => {
		const store = new JsonlAkashaStore(join(tempDir, "events", "session-edge.jsonl"));
		store.append({
			kind: "artifact.patched",
			sessionId: "session-edge",
			streamId: "session:session-edge",
			eventTime: "2026-05-12T00:00:00.000Z",
			actor: "tool",
			objectId: "src/ledger.ts",
			payload: { path: "src/ledger.ts", editCount: 1 },
		});
		store.append({
			kind: "tool.completed",
			sessionId: "session-edge",
			streamId: "session:session-edge",
			eventTime: "2026-05-12T00:01:00.000Z",
			actor: "tool",
			parentEventIds: ["evt-missing-parent"],
			objectId: "bash",
			payload: { toolName: "bash", isError: true, summary: "ledger failed", path: "src/ledger.ts" },
		});

		const firstEvents = store.buildTimeline({ limit: 1000 });
		const firstTraces = buildAkashaMemoryTraces(firstEvents);
		const cacheOptions = {
			agentDir: tempDir,
			eventLogDir: join(tempDir, "events"),
			scope: "session" as const,
			cacheKey: memoryTraceEdgeProjectionCacheKeyForScope("session-edge", 1000),
			sourceLogPaths: [store.eventLogPath],
			limit: 1000,
		};
		const first = buildCachedAkashaMemoryTraceEdgesFromEvents(firstEvents, firstTraces, cacheOptions);
		const second = buildCachedAkashaMemoryTraceEdgesFromEvents(firstEvents, firstTraces, cacheOptions);

		store.append({
			kind: "command.executed",
			sessionId: "session-edge",
			streamId: "session:session-edge",
			eventTime: "2026-05-12T00:02:00.000Z",
			actor: "tool",
			objectId: "npm test src/ledger.ts",
			payload: { command: "npm test src/ledger.ts", exitCode: 0, path: "src/ledger.ts" },
		});
		const changedEvents = store.buildTimeline({ limit: 1000 });
		const changedTraces = buildAkashaMemoryTraces(changedEvents);
		const rebuilt = buildCachedAkashaMemoryTraceEdgesFromEvents(changedEvents, changedTraces, cacheOptions);

		expect(first.rebuilt).toBe(true);
		expect(first.value.length).toBeGreaterThan(0);
		expect(second.rebuilt).toBe(false);
		expect(second.freshness.status).toBe("fresh");
		expect(rebuilt.rebuilt).toBe(true);
		expect(rebuilt.value.length).toBeGreaterThan(first.value.length);
	});

	it("can use strong source fingerprints", () => {
		const store = new JsonlAkashaStore(join(tempDir, "events", "session-strong.jsonl"));
		store.append({
			kind: "message.user.submitted",
			sessionId: "session-strong",
			streamId: "session:session-strong",
			eventTime: "2026-05-12T00:00:00.000Z",
			actor: "user",
			payload: { text: "Build strong fingerprints" },
		});

		const cached = loadOrBuildAkashaProjection(
			{
				agentDir: tempDir,
				scope: "session",
				cacheKey: "strong-fingerprint",
				sourceLogPaths: [store.eventLogPath],
				fingerprintMode: "strong",
			},
			() => ({ value: { ok: true }, events: store.buildTimeline({ limit: 10 }) }),
		);

		expect(cached.freshness.metadata?.sourceFingerprints[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
	});

	it("scopes project timeline cache source logs to matching cwd sessions", () => {
		const projectA = join(tempDir, "project-a");
		const projectB = join(tempDir, "project-b");
		const storeA = seedSession("session-a", projectA);
		seedSession("session-b", projectB);

		const timeline = buildAkashaProjectTimeline({
			agentDir: tempDir,
			eventLogDir: join(tempDir, "events"),
			cwd: projectA,
		});
		const freshness = getAkashaProjectionCacheFreshness({
			agentDir: tempDir,
			eventLogDir: join(tempDir, "events"),
			scope: "project",
			cacheKey: `project-timeline:${projectA}:all`,
			sourceLogPaths: [storeA.eventLogPath],
		});

		expect(timeline.sessions.map((session) => session.sessionId)).toEqual(["session-a"]);
		expect(freshness.status).toBe("fresh");
		expect(freshness.metadata?.sourceLogPaths).toEqual([storeA.eventLogPath]);
	});

	function seedSession(sessionId: string, cwd: string): JsonlAkashaStore {
		const store = new JsonlAkashaStore(join(tempDir, "events", `${sessionId}.jsonl`));
		store.append({
			kind: "session.started",
			sessionId,
			streamId: `session:${sessionId}`,
			eventTime: "2026-05-12T00:00:00.000Z",
			actor: "system",
			payload: { cwd },
		});
		return store;
	}
});
