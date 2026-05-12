import { describe, expect, it } from "vitest";
import { InMemoryAkashaEmbeddingStore } from "../src/core/akasha/embedding-store.js";
import { retrieveTemporalContext } from "../src/core/akasha/temporal-rag.js";
import type { AkashaEvent } from "../src/core/akasha/types.js";

describe("retrieveTemporalContext", () => {
	it("combines semantic similarity with temporal priority", async () => {
		const events = [
			event(1, "artifact.read", { path: "src/app.ts" }, { objectId: "src/app.ts" }),
			event(2, "tool.completed", { toolName: "bash", isError: true, text: "test failed" }, { objectId: "bash" }),
		];
		const embeddingStore = new InMemoryAkashaEmbeddingStore();
		await embeddingStore.upsert(record("read", "evt-1", [1, 0]));
		await embeddingStore.upsert(record("failed", "evt-2", [0.9, 0.1]));

		const result = await retrieveTemporalContext({
			events,
			embeddingStore,
			queryVector: [1, 0],
			limit: 2,
		});

		expect(result.matches[0]?.event.eventId).toBe("evt-2");
		expect(result.matches[0]?.reasons).toContain("failed_tool");
	});

	it("expands selected events through their causal parents", async () => {
		const events = [
			event(1, "message.user.submitted", { text: "fix tests" }, { actor: "user" }),
			event(2, "message.agent.completed", { text: "I'll run tests" }, { parentEventIds: ["evt-1"], actor: "agent" }),
			event(
				3,
				"tool.completed",
				{ toolName: "bash", isError: true },
				{ parentEventIds: ["evt-2"], objectId: "bash" },
			),
		];
		const embeddingStore = new InMemoryAkashaEmbeddingStore();
		await embeddingStore.upsert(record("leaf", "evt-3", [1, 0]));

		const result = await retrieveTemporalContext({
			events,
			embeddingStore,
			queryVector: [1, 0],
			limit: 1,
		});

		expect(result.events.map((item) => item.eventId)).toEqual(["evt-1", "evt-2", "evt-3"]);
	});

	it("boosts unresolved loops and marks resolved roots as stale", async () => {
		const events = [
			event(1, "tool.completed", { toolName: "bash", isError: true }, { objectId: "bash" }),
			event(2, "loop.opened", {
				loopKey: "evt-1:tool_failed_without_recovery",
				rootEventId: "evt-1",
				state: "open",
			}),
			event(3, "loop.resolved", {
				loopKey: "evt-1:tool_failed_without_recovery",
				rootEventId: "evt-1",
				state: "resolved",
			}),
			event(4, "tool.completed", { toolName: "bash", isError: true }, { objectId: "bash" }),
			event(5, "loop.opened", {
				loopKey: "evt-4:tool_failed_without_recovery",
				rootEventId: "evt-4",
				state: "open",
			}),
		];
		const embeddingStore = new InMemoryAkashaEmbeddingStore();
		await embeddingStore.upsert(record("resolved-root", "evt-1", [1, 0]));
		await embeddingStore.upsert(record("unresolved-root", "evt-4", [1, 0]));

		const result = await retrieveTemporalContext({
			events,
			embeddingStore,
			queryVector: [1, 0],
			limit: 2,
		});

		expect(result.matches[0]?.event.eventId).toBe("evt-4");
		expect(result.matches.find((match) => match.event.eventId === "evt-1")?.reasons).toContain("resolved_or_stale");
	});
});

function record(id: string, targetId: string, vector: number[]) {
	return {
		id,
		targetType: "event" as const,
		targetId,
		text: id,
		vector,
		createdAt: "2026-05-11T00:00:00.000Z",
	};
}

function event(
	sequence: number,
	kind: AkashaEvent["kind"],
	payload: Record<string, unknown>,
	overrides: Partial<AkashaEvent> = {},
): AkashaEvent {
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
		...overrides,
	};
}
