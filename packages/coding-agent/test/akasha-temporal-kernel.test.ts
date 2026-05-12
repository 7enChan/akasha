import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlAkashaStore } from "../src/core/akasha/jsonl-store.js";
import { createAkashaTemporalKernel } from "../src/core/akasha/temporal-kernel.js";

describe("Akasha temporal kernel", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "akasha-kernel-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("builds an auditable action context event", () => {
		const store = new JsonlAkashaStore(join(tempDir, "events.jsonl"));
		const user = store.append({
			kind: "message.user.submitted",
			sessionId: "session-1",
			streamId: "session:session-1",
			eventTime: "2026-05-12T00:00:00.000Z",
			actor: "user",
			payload: { text: "Implement the M13 temporal kernel" },
			ttlPolicy: "long_term",
		});
		store.append({
			kind: "time.callback.due",
			sessionId: "session-1",
			streamId: "session:session-1",
			eventTime: "2026-05-12T00:01:00.000Z",
			actor: "system",
			parentEventIds: [user.eventId],
			payload: {
				callbackId: "callback-1",
				kind: "scheduled_callback",
				dueTime: "2026-05-12T00:01:00.000Z",
				summary: "Review due callback",
				targetEventId: user.eventId,
			},
			ttlPolicy: "long_term",
		});
		const kernel = createAkashaTemporalKernel({
			store,
			sessionId: "session-1",
			streamId: "session:session-1",
			agentDir: tempDir,
			reflection: reflectionOff(),
		});

		const result = kernel.buildActionContext({
			cwd: tempDir,
			settings: {
				enabled: true,
				includeProjectState: false,
				includeUserTimeline: false,
				maxItems: 8,
				enforceToolGate: false,
				blockDestructiveCommands: true,
				blockUnverifiedArtifactWrites: false,
			},
			sourceKey: "action-gate-test",
			parentEventIds: [user.eventId],
		});

		expect(result.gate?.text).toContain("Due callbacks");
		expect(result.auditEvent).toMatchObject({
			kind: "action_gate.injected",
			parentEventIds: [user.eventId],
		});
		expect(result.auditEvent?.payload).toMatchObject({
			sections: expect.arrayContaining(["project_state", "due_callbacks"]),
			eventIds: expect.arrayContaining([user.eventId]),
		});
		expect(typeof result.auditEvent?.payload.contentHash).toBe("string");
	});

	it("exposes state and callback lifecycle operations", () => {
		const store = new JsonlAkashaStore(join(tempDir, "events.jsonl"));
		const kernel = createAkashaTemporalKernel({
			store,
			sessionId: "session-1",
			streamId: "session:session-1",
			agentDir: tempDir,
			reflection: reflectionOff(),
		});
		kernel.scheduleCallback({
			callbackId: "callback-2",
			kind: "scheduled_callback",
			dueTime: "2026-05-13T00:00:00.000Z",
			summary: "Follow up",
		});
		const completed = kernel.markCallbackCompleted("callback-2");

		expect(kernel.buildState().taskModel).toBeDefined();
		expect(completed.kind).toBe("time.callback.completed");
		expect(store.buildTimeline({ limit: 10 }).map((event) => event.kind)).toEqual(
			expect.arrayContaining(["time.callback.scheduled", "time.callback.completed"]),
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
