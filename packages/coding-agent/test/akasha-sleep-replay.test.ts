import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlAkashaStore } from "../src/core/akasha/jsonl-store.js";
import { buildAkashaSleepReplayStatus, runAkashaSleepReplayPass } from "../src/core/akasha/sleep-replay.js";

describe("Akasha sleep replay", () => {
	let tempDir: string;
	let store: JsonlAkashaStore;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "akasha-sleep-"));
		store = new JsonlAkashaStore(join(tempDir, "akasha", "events", "session-1.jsonl"));
		appendFixtureEvents(store);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("consolidates repeated failures, callback closures, and procedures", () => {
		const result = runAkashaSleepReplayPass(store, {
			now: new Date("2026-05-12T01:00:00.000Z"),
			limit: 100,
		});
		const kinds = store.buildTimeline({ limit: 100 }).map((event) => event.kind);
		const status = buildAkashaSleepReplayStatus(store.buildTimeline({ limit: 100 }));

		expect(result.started.kind).toBe("sleep.replay.started");
		expect(result.completed.kind).toBe("sleep.replay.completed");
		expect(result.failureLessons).toBeGreaterThan(0);
		expect(result.workflowOptimizations).toBeGreaterThan(0);
		expect(result.procedures).toBeGreaterThan(0);
		expect(kinds).toEqual(
			expect.arrayContaining(["failure.lesson_learned", "workflow.optimized", "skill.procedure.created"]),
		);
		expect(status.replayCount).toBe(1);
	});
});

function appendFixtureEvents(store: JsonlAkashaStore): void {
	store.append({
		kind: "session.started",
		sessionId: "session-1",
		streamId: "session:session-1",
		eventTime: "2026-05-12T00:00:00.000Z",
		actor: "system",
		payload: { cwd: "/repo" },
	});
	for (const minute of [1, 2]) {
		store.append({
			kind: "tool.completed",
			sessionId: "session-1",
			streamId: "session:session-1",
			eventTime: `2026-05-12T00:0${minute}:00.000Z`,
			actor: "tool",
			subjectId: "bash",
			objectId: "bash",
			payload: { toolName: "bash", isError: true, summary: "package root test failure" },
		});
	}
	store.append({
		kind: "command.executed",
		sessionId: "session-1",
		streamId: "session:session-1",
		eventTime: "2026-05-12T00:03:00.000Z",
		actor: "tool",
		objectId: "npm --prefix packages/coding-agent test -- akasha",
		payload: { command: "npm --prefix packages/coding-agent test -- akasha", exitCode: 0, cwd: "/repo" },
	});
	store.append({
		kind: "command.executed",
		sessionId: "session-1",
		streamId: "session:session-1",
		eventTime: "2026-05-12T00:03:30.000Z",
		actor: "tool",
		objectId: "npm --prefix packages/coding-agent test -- akasha",
		payload: { command: "npm --prefix packages/coding-agent test -- akasha", exitCode: 0, cwd: "/repo" },
	});
	store.append({
		kind: "time.callback.completed",
		sessionId: "session-1",
		streamId: "session:session-1",
		eventTime: "2026-05-12T00:04:00.000Z",
		actor: "system",
		payload: { callbackId: "callback-1", summary: "Commitment resolved" },
	});
}
