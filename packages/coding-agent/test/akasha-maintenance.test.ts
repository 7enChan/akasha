import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HashAkashaEmbeddingProvider } from "../src/core/akasha/embedding-provider.js";
import { InMemoryAkashaEmbeddingStore } from "../src/core/akasha/embedding-store.js";
import { JsonlAkashaStore } from "../src/core/akasha/jsonl-store.js";
import { runAkashaMaintenancePass } from "../src/core/akasha/maintenance.js";
import { decideReflection } from "../src/core/akasha/reflection-policy.js";
import type { AkashaEvent } from "../src/core/akasha/types.js";

describe("Akasha maintenance", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "akasha-maintenance-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("decides reflection from event count and interval", () => {
		expect(
			decideReflection([event(1, "message.user.submitted", { text: "hello" })], {
				enabled: true,
				minEventsSinceLastReflection: 2,
				minIntervalMinutes: 60,
			}),
		).toMatchObject({ shouldRun: true, reason: "no_previous_reflection" });

		expect(
			decideReflection(
				[
					event(1, "reflection.completed", {}, { eventTime: "2026-05-11T00:00:00.000Z" }),
					event(2, "message.user.submitted", { text: "hello" }, { eventTime: "2026-05-11T00:10:00.000Z" }),
				],
				{
					enabled: true,
					minEventsSinceLastReflection: 5,
					minIntervalMinutes: 60,
				},
				new Date("2026-05-11T00:20:00.000Z"),
			),
		).toMatchObject({ shouldRun: false, reason: "not_due", eventsSinceLastReflection: 1 });
	});

	it("runs open-loop, scheduler, embedding, and reflection maintenance", async () => {
		const store = new JsonlAkashaStore(join(tempDir, "events.jsonl"));
		store.append({
			kind: "artifact.patched",
			sessionId: "session-1",
			streamId: "session:session-1",
			eventTime: "2026-05-11T00:00:00.000Z",
			actor: "tool",
			objectId: "src/app.ts",
			payload: { path: "src/app.ts" },
		});
		store.append({
			kind: "promise.created",
			sessionId: "session-1",
			streamId: "session:session-1",
			eventTime: "2026-05-11T00:00:01.000Z",
			actor: "agent",
			payload: {
				promiseId: "promise-1",
				summary: "Run build",
				dueTime: "2026-05-10T00:00:00.000Z",
			},
		});

		const result = await runAkashaMaintenancePass(store, {
			sessionId: "session-1",
			streamId: "session:session-1",
			reflection: {
				enabled: true,
				minEventsSinceLastReflection: 1,
				minIntervalMinutes: 1,
			},
			embeddingStore: new InMemoryAkashaEmbeddingStore(),
			embeddingProvider: new HashAkashaEmbeddingProvider(32),
			now: new Date("2026-05-11T00:10:00.000Z"),
		});

		expect(result.openLoopEvents.map((item) => item.kind)).toContain("loop.opened");
		expect(result.schedulerEvents.map((item) => item.kind)).toContain("promise.updated");
		expect(result.embeddingIndexed).toBeGreaterThan(0);
		expect(result.reflection?.completed.kind).toBe("reflection.completed");
	});
});

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
