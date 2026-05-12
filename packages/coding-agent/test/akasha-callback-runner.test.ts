import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRunnableCallbacks, runAkashaCallbackRunner } from "../src/core/akasha/callback-runner.js";
import { JsonlAkashaStore } from "../src/core/akasha/jsonl-store.js";

describe("Akasha callback runner", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "akasha-callback-runner-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("claims and dispatches due callbacks with an auditable policy decision", () => {
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
				summary: "Follow up on M22",
			},
			ttlPolicy: "long_term",
		});

		const result = runAkashaCallbackRunner(store, {
			reflection: reflectionOff(),
			now: new Date("2026-05-12T00:01:00.000Z"),
		});
		const duplicate = runAkashaCallbackRunner(store, {
			reflection: reflectionOff(),
			now: new Date("2026-05-12T00:02:00.000Z"),
		});

		expect(result.claimed).toHaveLength(1);
		expect(result.dispatched).toHaveLength(1);
		expect(result.policies[0]?.decision.action).toBe("allow");
		expect(duplicate.claimed).toHaveLength(0);
		expect(duplicate.dispatched).toHaveLength(0);
		expect(store.buildTimeline({ limit: 20 }).map((event) => event.kind)).toEqual(
			expect.arrayContaining(["time.callback.claimed", "policy.evaluated", "time.callback.dispatched"]),
		);
	});

	it("does not run terminal callbacks", () => {
		const store = new JsonlAkashaStore(join(tempDir, "events.jsonl"));
		store.append({
			kind: "time.callback.due",
			sessionId: "session-1",
			streamId: "session:session-1",
			eventTime: "2026-05-12T00:00:00.000Z",
			actor: "system",
			payload: { callbackId: "callback-2", summary: "Already done" },
		});
		store.append({
			kind: "time.callback.completed",
			sessionId: "session-1",
			streamId: "session:session-1",
			eventTime: "2026-05-12T00:01:00.000Z",
			actor: "system",
			payload: { callbackId: "callback-2" },
		});

		expect(buildRunnableCallbacks(store.buildTimeline({ limit: 20 }))).toHaveLength(0);
	});
});

function reflectionOff() {
	return {
		enabled: false,
		minEventsSinceLastReflection: 40,
		minIntervalMinutes: 240,
	};
}
