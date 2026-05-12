import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTemporalBriefWithEmbeddings } from "../src/core/akasha/brief.js";
import { eventEmbeddingText, indexAkashaEmbeddings } from "../src/core/akasha/embedding-indexer.js";
import { HashAkashaEmbeddingProvider } from "../src/core/akasha/embedding-provider.js";
import { InMemoryAkashaEmbeddingStore, JsonlAkashaEmbeddingStore } from "../src/core/akasha/embedding-store.js";
import { JsonlAkashaStore } from "../src/core/akasha/jsonl-store.js";
import type { AkashaEvent } from "../src/core/akasha/types.js";

describe("Akasha embeddings", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "akasha-embedding-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("persists embedding records across JSONL store reloads", async () => {
		const path = join(tempDir, "embeddings.jsonl");
		const store = new JsonlAkashaEmbeddingStore(path);
		await store.upsert({
			id: "record-1",
			targetType: "event",
			targetId: "evt-1",
			text: "build failed",
			vector: [1, 0],
			createdAt: "2026-05-11T00:00:00.000Z",
		});

		const reloaded = new JsonlAkashaEmbeddingStore(path);

		expect(await reloaded.has("record-1")).toBe(true);
		expect((await reloaded.search([1, 0], { limit: 1 }))[0]?.record.targetId).toBe("evt-1");
	});

	it("indexes events idempotently with a local hash provider", async () => {
		const store = new InMemoryAkashaEmbeddingStore();
		const provider = new HashAkashaEmbeddingProvider(32);
		const events = [event(1, "tool.completed", { toolName: "bash", isError: true, text: "build failed" })];

		const first = await indexAkashaEmbeddings(events, store, provider);
		const second = await indexAkashaEmbeddings(events, store, provider);

		expect(first).toMatchObject({ considered: 1, indexed: 1, skipped: 0 });
		expect(second).toMatchObject({ considered: 1, indexed: 0, skipped: 1 });
	});

	it("extracts crystal and calibration text for embeddings", () => {
		expect(
			eventEmbeddingText(event(1, "memory.crystal.created", { statement: "User prefers explicit time syscalls" })),
		).toContain("User prefers explicit time syscalls");
		expect(
			eventEmbeddingText(
				event(2, "prediction.corrected", {
					claim: "Build will pass",
					actual: "Build failed",
					correction: "Run typecheck before claiming completion",
				}),
			),
		).toContain("Build failed");
	});

	it("uses semantic temporal recall when building a brief", async () => {
		const eventStore = new JsonlAkashaStore(join(tempDir, "events.jsonl"));
		eventStore.append({
			kind: "message.user.submitted",
			sessionId: "session-1",
			streamId: "session:session-1",
			eventTime: "2026-05-11T00:00:00.000Z",
			actor: "user",
			payload: { text: "Why did build fail?" },
		});
		eventStore.append({
			kind: "tool.completed",
			sessionId: "session-1",
			streamId: "session:session-1",
			eventTime: "2026-05-11T00:00:01.000Z",
			actor: "tool",
			objectId: "bash",
			payload: { toolName: "bash", isError: true, text: "build failed on export mismatch" },
		});
		const brief = await buildTemporalBriefWithEmbeddings(eventStore, {
			embeddingStore: new InMemoryAkashaEmbeddingStore(),
			embeddingProvider: new HashAkashaEmbeddingProvider(64),
			queryText: "build failed",
			maxEvents: 4,
		});

		expect(brief?.text).toContain("Semantic temporal recall");
		expect(brief?.text).toContain("build failed on export mismatch");
	});
});

function event(sequence: number, kind: AkashaEvent["kind"], payload: Record<string, unknown>): AkashaEvent {
	return {
		eventId: `evt-${sequence}`,
		kind,
		sessionId: "session-1",
		streamId: "session:session-1",
		sequence,
		eventTime: new Date(sequence * 1000).toISOString(),
		recordedTime: new Date(sequence * 1000).toISOString(),
		actor: "system",
		parentEventIds: [],
		payload,
		importance: 0.5,
		ttlPolicy: "long_term",
		version: 1,
	};
}
