import { describe, expect, it } from "vitest";
import { HashAkashaEmbeddingProvider } from "../src/core/akasha/embedding-provider.js";
import { InMemoryAkashaEmbeddingStore } from "../src/core/akasha/embedding-store.js";
import { buildAkashaSemanticMemorySeeds, SEMANTIC_SEED_LIMIT } from "../src/core/akasha/semantic-memory-seed.js";
import type { AkashaEvent } from "../src/core/akasha/types.js";

describe("Akasha semantic memory seeds", () => {
	it("indexes current events and returns deterministic positive semantic seeds", async () => {
		const events = [
			event(1, "artifact.patched", {
				path: "src/ledger.ts",
				summary: "ledger reconciliation adapter updated",
			}),
			event(2, "tool.completed", {
				toolName: "bash",
				isError: true,
				summary: "checkout smoke test failed",
			}),
		];
		const store = new InMemoryAkashaEmbeddingStore();
		const provider = new HashAkashaEmbeddingProvider(128);

		const first = await buildAkashaSemanticMemorySeeds({
			events,
			embeddingStore: store,
			embeddingProvider: provider,
			queryText: "ledger reconciliation",
			now: () => "2026-05-12T00:00:00.000Z",
		});
		const second = await buildAkashaSemanticMemorySeeds({
			events,
			embeddingStore: store,
			embeddingProvider: provider,
			queryText: "ledger reconciliation",
			now: () => "2026-05-12T00:00:00.000Z",
		});

		expect(first).toEqual(second);
		expect(first[0]).toMatchObject({
			eventId: "evt-1",
			reason: expect.stringContaining("embedding:event:event:evt-1"),
		});
		expect(first[0]?.score).toBeGreaterThan(0);
		expect(first[0]?.score).toBeLessThanOrEqual(0.65);
		expect(first.length).toBeLessThanOrEqual(SEMANTIC_SEED_LIMIT);
	});

	it("does not emit seeds for empty query text", async () => {
		const store = new InMemoryAkashaEmbeddingStore();
		const provider = new HashAkashaEmbeddingProvider(64);

		await expect(
			buildAkashaSemanticMemorySeeds({
				events: [event(1, "message.user.submitted", { text: "remember src/foo.ts" })],
				embeddingStore: store,
				embeddingProvider: provider,
				queryText: "   ",
			}),
		).resolves.toEqual([]);
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
