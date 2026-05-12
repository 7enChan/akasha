import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAkashaDaemonQueue, runAkashaDaemonQueuePass } from "../src/core/akasha/daemon-queue.js";
import { JsonlAkashaStore } from "../src/core/akasha/jsonl-store.js";
import type { AkashaEvent } from "../src/core/akasha/types.js";

describe("Akasha daemon queue", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "akasha-daemon-queue-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("derives due callbacks from overdue promises and due predictions", () => {
		const queue = buildAkashaDaemonQueue(
			[
				event(1, "promise.created", {
					promiseId: "promise-1",
					summary: "Run tests",
					dueTime: "2026-05-11T00:00:00.000Z",
				}),
				event(2, "prediction.made", {
					predictionId: "prediction-1",
					claim: "Build should pass",
					checkAfter: "2026-05-11T00:00:00.000Z",
				}),
			],
			{ now: new Date("2026-05-12T00:00:00.000Z"), reflection: reflectionOff() },
		);

		expect(queue.map((item) => item.kind)).toEqual(["promise_due", "prediction_due"]);
	});

	it("appends daemon tick and due callback events idempotently", () => {
		const store = new JsonlAkashaStore(join(tempDir, "events.jsonl"));
		store.append({
			kind: "promise.created",
			sessionId: "session-1",
			streamId: "session:session-1",
			eventTime: "2026-05-11T00:00:00.000Z",
			actor: "agent",
			payload: {
				promiseId: "promise-1",
				summary: "Run tests",
				dueTime: "2026-05-11T00:00:00.000Z",
			},
			ttlPolicy: "long_term",
		});

		const first = runAkashaDaemonQueuePass(store, {
			now: new Date("2026-05-12T00:00:00.000Z"),
			reflection: reflectionOff(),
		});
		const second = runAkashaDaemonQueuePass(store, {
			now: new Date("2026-05-12T00:01:00.000Z"),
			reflection: reflectionOff(),
		});

		expect(first.dueCallbacks).toHaveLength(1);
		expect(second.dueCallbacks).toHaveLength(0);
		expect(store.buildTimeline({ limit: 20 }).map((item) => item.kind)).toEqual(
			expect.arrayContaining(["daemon.tick", "time.callback.due"]),
		);
	});
});

function reflectionOff() {
	return {
		enabled: false,
		minEventsSinceLastReflection: 40,
		minIntervalMinutes: 240,
	};
}

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
