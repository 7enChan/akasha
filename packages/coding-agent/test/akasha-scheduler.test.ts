import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlAkashaStore } from "../src/core/akasha/jsonl-store.js";
import { deriveSchedulerEvents, runAkashaSchedulerPass } from "../src/core/akasha/scheduler.js";
import type { AkashaEvent } from "../src/core/akasha/types.js";

describe("Akasha scheduler", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "akasha-scheduler-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("derives overdue promise and due prediction events", () => {
		const drafts = deriveSchedulerEvents(
			[
				event(1, "promise.created", {
					promiseId: "promise-1",
					summary: "Run build",
					dueTime: "2026-05-10T00:00:00.000Z",
				}),
				event(2, "prediction.made", {
					predictionId: "prediction-1",
					claim: "Build should pass",
					checkAfter: "2026-05-10T00:00:00.000Z",
				}),
			],
			new Date("2026-05-11T00:00:00.000Z"),
		);

		expect(drafts.map((draft) => draft.kind)).toEqual(["promise.updated", "loop.opened"]);
		expect(drafts[0]?.sourceKey).toContain("promise-overdue");
		expect(drafts[1]?.payload?.reason).toBe("prediction_due");
	});

	it("resolves validation promises from later successful command evidence", () => {
		const drafts = deriveSchedulerEvents(
			[
				event(1, "promise.created", {
					promiseId: "promise-1",
					summary: "I will run the build",
					dueTime: "2026-05-10T00:00:00.000Z",
				}),
				event(2, "command.executed", {
					command: "npm run build",
					isError: false,
				}),
			],
			new Date("2026-05-11T00:00:00.000Z"),
		);

		expect(drafts.map((draft) => draft.kind)).toEqual(["promise.resolved"]);
		expect(drafts[0]?.payload?.resolverEventId).toBe("evt-2");
	});

	it("checks or corrects predictions from later command evidence", () => {
		const checked = deriveSchedulerEvents(
			[
				event(1, "prediction.made", {
					predictionId: "prediction-1",
					claim: "The tests should pass",
					checkAfter: "2026-05-10T00:00:00.000Z",
				}),
				event(2, "command.executed", {
					command: "npm test",
					isError: false,
				}),
			],
			new Date("2026-05-11T00:00:00.000Z"),
		);
		const corrected = deriveSchedulerEvents(
			[
				event(1, "prediction.made", {
					predictionId: "prediction-2",
					claim: "The build should pass",
					checkAfter: "2026-05-10T00:00:00.000Z",
				}),
				event(2, "command.executed", {
					command: "npm run build",
					isError: true,
				}),
			],
			new Date("2026-05-11T00:00:00.000Z"),
		);

		expect(checked.map((draft) => draft.kind)).toEqual(["prediction.checked"]);
		expect(checked[0]?.payload?.correct).toBe(true);
		expect(corrected.map((draft) => draft.kind)).toEqual(["prediction.corrected"]);
		expect(corrected[0]?.payload?.correct).toBe(false);
	});

	it("appends idempotent scheduler events to a store", () => {
		const store = new JsonlAkashaStore(join(tempDir, "events.jsonl"));
		store.append({
			kind: "promise.created",
			sessionId: "session-1",
			streamId: "session:session-1",
			eventTime: "2026-05-09T00:00:00.000Z",
			actor: "agent",
			payload: {
				promiseId: "promise-1",
				summary: "Run build",
				dueTime: "2026-05-10T00:00:00.000Z",
			},
		});

		const first = runAkashaSchedulerPass(store, { now: new Date("2026-05-11T00:00:00.000Z") });
		const second = runAkashaSchedulerPass(store, { now: new Date("2026-05-11T00:00:00.000Z") });

		expect(first.appended.map((item) => item.kind)).toEqual(["promise.updated"]);
		expect(second.appended.map((item) => item.eventId)).toEqual(first.appended.map((item) => item.eventId));
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
