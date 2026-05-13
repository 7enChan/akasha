import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlAkashaStore } from "../src/core/akasha/jsonl-store.js";
import { createMemoryAppliedDraft, createMemoryOutcomeDraft } from "../src/core/akasha/memory-recall-events.js";
import { buildAkashaMemoryTraces } from "../src/core/akasha/memory-trace.js";
import { runAkashaSleepReplayPass } from "../src/core/akasha/sleep-replay.js";
import { createAkashaTemporalKernel } from "../src/core/akasha/temporal-kernel.js";
import { SettingsManager } from "../src/core/settings-manager.js";

describe("Akasha holographic memory end-to-end behavior", () => {
	let tempDir: string;
	let cwd: string;
	let store: JsonlAkashaStore;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "akasha-hml-e2e-"));
		cwd = join(tempDir, "repo");
		store = new JsonlAkashaStore(join(tempDir, "akasha", "events", "session-1.jsonl"));
		appendExperience(store, cwd);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("replays failures into memory, recalls them, and reinforces useful traces after success", () => {
		runAkashaSleepReplayPass(store, {
			now: new Date("2026-05-12T02:00:00.000Z"),
			limit: 100,
		});
		const settings = SettingsManager.inMemory({
			akasha: {
				actionGate: { enabled: true, includeProjectState: false, includeUserTimeline: false },
				holographicMemory: { enabled: true, injectIntoActionGate: true, recordRecallEvents: true },
			},
		}).getAkashaSettings();
		const kernel = createAkashaTemporalKernel({
			store,
			sessionId: "session-1",
			streamId: "session:session-1",
			agentDir: tempDir,
			reflection: settings.reflection,
		});

		const result = kernel.buildActionContext({
			cwd,
			settings: settings.actionGate,
			holographicMemory: settings.holographicMemory,
			latestUserText: "Rerun Akasha tests from the correct package root",
			sourceKey: "hml-e2e-action-gate",
			correlationId: "turn-1",
			turnEventId: "turn-1",
		});
		const recalled = store.buildTimeline({ limit: 200 }).find((event) => event.kind === "memory.recalled");
		const targetTraceId = result.memoryField?.recalledTraceIds[0];
		expect(result.memoryField?.lessons.length).toBeGreaterThan(0);
		expect(result.memoryField?.procedures.length).toBeGreaterThan(0);
		expect(recalled).toBeDefined();
		expect(targetTraceId).toBeDefined();

		const before = buildAkashaMemoryTraces(store.buildTimeline({ limit: 200 })).find(
			(trace) => trace.traceId === targetTraceId,
		);
		const outcome = store.append({
			kind: "tool.completed",
			sessionId: "session-1",
			streamId: "session:session-1",
			eventTime: "2026-05-12T02:01:00.000Z",
			actor: "tool",
			subjectId: "bash",
			objectId: "bash",
			toolCallId: "tool-1",
			payload: { toolName: "bash", isError: false, summary: "Akasha package tests passed" },
		});
		const applied = store.append(
			createMemoryAppliedDraft({
				sessionId: "session-1",
				streamId: "session:session-1",
				recallEventId: recalled!.eventId,
				actionType: "tool_call",
				toolCallId: "tool-1",
				toolName: "bash",
			}),
		);
		store.append(
			createMemoryOutcomeDraft({
				kind: "memory.reinforced",
				sessionId: "session-1",
				streamId: "session:session-1",
				recallEventId: recalled!.eventId,
				appliedEventId: applied.eventId,
				outcomeEvent: outcome,
				reason: "tool_result_succeeded",
			}),
		);
		const after = buildAkashaMemoryTraces(store.buildTimeline({ limit: 200 })).find(
			(trace) => trace.traceId === targetTraceId,
		);

		expect(before?.weight).toBeLessThan(after?.weight ?? 0);
	});
});

function appendExperience(store: JsonlAkashaStore, cwd: string): void {
	store.append({
		kind: "session.started",
		sessionId: "session-1",
		streamId: "session:session-1",
		eventTime: "2026-05-12T00:00:00.000Z",
		actor: "system",
		payload: { cwd },
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
			payload: {
				toolName: "bash",
				isError: true,
				summary: "npm test failed because cwd was wrong for packages/coding-agent",
			},
		});
	}
	for (const minute of [3, 4]) {
		store.append({
			kind: "command.executed",
			sessionId: "session-1",
			streamId: "session:session-1",
			eventTime: `2026-05-12T00:0${minute}:00.000Z`,
			actor: "tool",
			objectId: "npm --prefix packages/coding-agent test -- akasha",
			payload: { command: "npm --prefix packages/coding-agent test -- akasha", exitCode: 0, cwd },
		});
	}
}
