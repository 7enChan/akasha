import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildAkashaDaemonQueue,
	markAkashaCallbackCancelled,
	markAkashaCallbackCompleted,
	runAkashaDaemonQueuePass,
} from "../src/core/akasha/daemon-queue.js";
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

	it("schedules future callbacks and advances them to due only once", () => {
		const store = new JsonlAkashaStore(join(tempDir, "events.jsonl"));
		store.append({
			kind: "promise.created",
			sessionId: "session-1",
			streamId: "session:session-1",
			eventTime: "2026-05-11T00:00:00.000Z",
			actor: "agent",
			payload: {
				promiseId: "promise-future",
				summary: "Check the build tomorrow",
				dueTime: "2026-05-13T00:00:00.000Z",
			},
			ttlPolicy: "long_term",
		});

		const scheduled = runAkashaDaemonQueuePass(store, {
			now: new Date("2026-05-12T00:00:00.000Z"),
			reflection: reflectionOff(),
		});
		const due = runAkashaDaemonQueuePass(store, {
			now: new Date("2026-05-13T00:01:00.000Z"),
			reflection: reflectionOff(),
		});
		const duplicateDue = runAkashaDaemonQueuePass(store, {
			now: new Date("2026-05-13T00:02:00.000Z"),
			reflection: reflectionOff(),
		});

		expect(scheduled.scheduledCallbacks).toHaveLength(1);
		expect(due.dueCallbacks).toHaveLength(1);
		expect(duplicateDue.dueCallbacks).toHaveLength(0);
		expect(store.buildTimeline({ limit: 50 }).map((item) => item.kind)).toEqual(
			expect.arrayContaining(["time.callback.scheduled", "time.callback.due"]),
		);
	});

	it("completes and cancels callbacks as terminal lifecycle events", () => {
		const store = new JsonlAkashaStore(join(tempDir, "events.jsonl"));
		store.append({
			kind: "time.callback.due",
			sessionId: "session-1",
			streamId: "session:session-1",
			eventTime: "2026-05-12T00:00:00.000Z",
			actor: "system",
			payload: {
				callbackId: "callback-1",
				kind: "scheduled_callback",
				dueTime: "2026-05-12T00:00:00.000Z",
				summary: "Follow up",
			},
			ttlPolicy: "long_term",
		});

		const completed = markAkashaCallbackCompleted(store, "callback-1", {
			evidenceEventId: "evt-evidence",
			reason: "verified",
		});
		const cancelled = markAkashaCallbackCancelled(store, "callback-2", { reason: "obsolete" });

		expect(completed.kind).toBe("time.callback.completed");
		expect(completed.payload).toMatchObject({ callbackId: "callback-1", evidenceEventId: "evt-evidence" });
		expect(cancelled.kind).toBe("time.callback.cancelled");
		expect(cancelled.payload).toMatchObject({ callbackId: "callback-2", reason: "obsolete" });
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
