import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlAkashaStore } from "../src/core/akasha/jsonl-store.js";
import {
	buildCachedAkashaTemporalStateSnapshot,
	getAkashaProjectionCacheFreshness,
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
});
