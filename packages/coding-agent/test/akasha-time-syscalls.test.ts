import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listAkashaActionableCallbackPrompts, projectAkashaCallbackInbox } from "../src/core/akasha/callback-inbox.js";
import { runAkashaCallbackRunner } from "../src/core/akasha/callback-runner.js";
import { JsonlAkashaStore } from "../src/core/akasha/jsonl-store.js";
import { buildKarmaLedger } from "../src/core/akasha/karma-ledger.js";
import {
	appendAkashaCommitment,
	appendAkashaCommitmentResolution,
	appendAkashaPrediction,
	appendAkashaPredictionCheck,
} from "../src/core/akasha/time-syscalls.js";

describe("Akasha time syscalls", () => {
	let tempDir: string;
	let store: JsonlAkashaStore;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "akasha-syscalls-"));
		store = new JsonlAkashaStore(join(tempDir, "events.jsonl"));
	});

	afterEach(() => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("creates and resolves explicit commitments", () => {
		const created = appendAkashaCommitment(baseContext("call-1"), {
			summary: "Run full Akasha validation",
			dueTime: "2026-05-12T00:00:00.000Z",
			resolutionCriteria: "All Akasha tests pass",
			confidence: 0.95,
			sourceEventIds: ["evt-assistant"],
		});
		const resolved = appendAkashaCommitmentResolution(baseContext("call-2"), {
			promiseId: created.payload.promiseId as string,
			resolution: "validated",
			evidenceEventId: "evt-build",
		});

		const ledger = buildKarmaLedger(store.buildTimeline());

		expect(created.kind).toBe("promise.created");
		expect(created.payload.source).toBe("syscall");
		expect(created.parentEventIds).toContain("evt-assistant");
		expect(resolved.kind).toBe("promise.resolved");
		expect(ledger.promises[0]).toMatchObject({
			state: "resolved",
			resolution: "validated",
		});
	});

	it("creates and corrects explicit predictions", () => {
		const prediction = appendAkashaPrediction(baseContext("call-3"), {
			claim: "The task graph eval should pass",
			checkAfter: "2026-05-12T00:00:00.000Z",
			confidence: 0.7,
			resolutionCriteria: "Focused test exits 0",
		});
		const checked = appendAkashaPredictionCheck(baseContext("call-4"), {
			predictionId: prediction.payload.predictionId as string,
			actual: "Focused test initially failed",
			correct: false,
			correction: "A fixture assertion needed a stable event",
		});

		const ledger = buildKarmaLedger(store.buildTimeline());

		expect(prediction.kind).toBe("prediction.made");
		expect(checked.kind).toBe("prediction.corrected");
		expect(ledger.predictions[0]).toMatchObject({
			state: "corrected",
			actual: "Focused test initially failed",
			correction: "A fixture assertion needed a stable event",
		});
	});

	it("resolves a commitment and automatically closes its callback inbox item", () => {
		const created = appendAkashaCommitment(baseContext("call-create"), {
			summary: "Close the M41 callback",
		});
		appendDueCallback("callback-m41", "Close the M41 callback", created.eventId);
		runAkashaCallbackRunner(store, {
			reflection: reflectionOff(),
			dispatchMode: "agent_prompt_file",
			agentDir: tempDir,
			now: new Date("2026-05-12T00:01:00.000Z"),
		});
		const [inbox] = listAkashaActionableCallbackPrompts(tempDir);

		const resolved = appendAkashaCommitmentResolution(
			{ ...baseContext("call-resolve"), agentDir: tempDir },
			{
				promiseId: created.payload.promiseId as string,
				resolution: "completed through resume",
				callbackId: "callback-m41",
				inboxItemId: inbox?.prompt.id,
			},
		);
		const kinds = store.buildTimeline({ limit: 50 }).map((event) => event.kind);

		expect(resolved.kind).toBe("promise.resolved");
		expect(kinds).toEqual(expect.arrayContaining(["time.callback.completed", "callback.inbox.consumed"]));
		expect(listAkashaActionableCallbackPrompts(tempDir)).toHaveLength(0);
		expect(projectAkashaCallbackInbox(tempDir)[0]).toMatchObject({ status: "consumed" });
	});

	it("checks a prediction and automatically closes a callback using inboxItemId", () => {
		const prediction = appendAkashaPrediction(baseContext("call-predict"), {
			claim: "M41 prediction closure should work",
		});
		appendDueCallback("callback-prediction", "Check the M41 prediction", prediction.eventId);
		runAkashaCallbackRunner(store, {
			reflection: reflectionOff(),
			dispatchMode: "agent_prompt_file",
			agentDir: tempDir,
			now: new Date("2026-05-12T00:01:00.000Z"),
		});
		const [inbox] = listAkashaActionableCallbackPrompts(tempDir);

		const checked = appendAkashaPredictionCheck(
			{ ...baseContext("call-check"), agentDir: tempDir },
			{
				predictionId: prediction.payload.predictionId as string,
				actual: "Prediction closure worked",
				correct: true,
				inboxItemId: inbox?.prompt.id,
			},
		);
		const timeline = store.buildTimeline({ limit: 50 });

		expect(checked.kind).toBe("prediction.checked");
		expect(timeline.map((event) => event.kind)).toEqual(
			expect.arrayContaining(["time.callback.completed", "callback.inbox.consumed"]),
		);
		expect(timeline.find((event) => event.kind === "time.callback.completed")?.payload).toMatchObject({
			callbackId: "callback-prediction",
			evidenceEventId: checked.eventId,
		});
	});

	function baseContext(toolCallId: string) {
		return {
			store,
			sessionId: "session-1",
			streamId: "session:session-1",
			now: () => "2026-05-11T00:00:00.000Z",
			parentEventIds: ["evt-parent"],
			correlationId: "turn-1",
			toolCallId,
			sourceKeyPrefix: "test-syscall",
		};
	}

	function appendDueCallback(callbackId: string, summary: string, targetEventId: string): void {
		store.append({
			kind: "time.callback.due",
			sessionId: "session-1",
			streamId: "session:session-1",
			eventTime: "2026-05-12T00:00:00.000Z",
			actor: "system",
			objectId: targetEventId,
			payload: {
				callbackId,
				kind: "promise_followup",
				summary,
				targetEventId,
			},
			ttlPolicy: "long_term",
		});
	}
});

function reflectionOff() {
	return {
		enabled: false,
		minEventsSinceLastReflection: 40,
		minIntervalMinutes: 240,
	};
}
