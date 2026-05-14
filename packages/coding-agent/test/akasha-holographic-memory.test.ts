import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reconstructAkashaMemoryField } from "../src/core/akasha/holographic-memory.js";
import { JsonlAkashaStore } from "../src/core/akasha/jsonl-store.js";
import { buildAkashaMemoryCue } from "../src/core/akasha/memory-cue.js";
import { buildAkashaMemoryTraces } from "../src/core/akasha/memory-trace.js";
import { createAkashaTemporalKernel } from "../src/core/akasha/temporal-kernel.js";
import { SettingsManager } from "../src/core/settings-manager.js";

describe("Akasha holographic memory", () => {
	let tempDir: string;
	let cwd: string;
	let store: JsonlAkashaStore;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "akasha-hml-"));
		cwd = join(tempDir, "project");
		store = new JsonlAkashaStore(join(tempDir, "akasha", "events", "session-1.jsonl"));
		appendFixtureEvents(store, cwd);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("reconstructs a cue-driven memory field from traces", () => {
		const events = store.buildTimeline({ limit: 100 });
		const cue = buildAkashaMemoryCue({
			latestUserText: "Fix src/foo.ts and rerun the foo test",
			cwd,
			sessionEvents: events,
		});
		const traces = buildAkashaMemoryTraces(events);
		const patchEvent = events.find((event) => event.kind === "artifact.patched");
		expect(patchEvent).toBeDefined();
		const field = reconstructAkashaMemoryField({
			events,
			traces,
			cue,
			semanticSeeds: [
				{
					eventId: patchEvent!.eventId,
					score: 0.5,
					similarity: 0.77,
					reason: "embedding:event:test:0.7700",
				},
			],
			options: { maxTraces: 24, maxEpisodes: 3, maxLessons: 3, maxProcedures: 2, maxWarnings: 3 },
		});

		expect(field.recalledTraceIds.length).toBeGreaterThan(0);
		expect(field.recalledEdgeIds.length).toBeGreaterThan(0);
		expect(Object.keys(field.activationReasons).length).toBeGreaterThan(0);
		expect(field.semanticSeedEventIds).toContain(patchEvent!.eventId);
		expect(field.semanticSeedReasons[patchEvent!.eventId]?.[0]).toContain("embedding:event:test");
		expect(field.episodes.some((episode) => episode.title.includes("src/foo.ts"))).toBe(true);
		expect(field.warnings.some((warning) => warning.text.includes("foo test failed"))).toBe(true);
		expect(field.procedures.some((procedure) => procedure.title.includes("npm test src/foo.test.ts"))).toBe(true);
	});

	it("injects holographic memory through Action Gate and records memory.recalled", () => {
		const settings = SettingsManager.inMemory({
			akasha: {
				actionGate: { enabled: true, includeProjectState: true, includeUserTimeline: false },
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
		const seedEventId = store
			.buildTimeline({ limit: 100 })
			.find((event) => event.kind === "artifact.patched")?.eventId;
		expect(seedEventId).toBeDefined();

		const result = kernel.buildActionContext({
			cwd,
			settings: settings.actionGate,
			holographicMemory: settings.holographicMemory,
			latestUserText: "Continue fixing src/foo.ts",
			semanticMemorySeeds: [
				{
					eventId: seedEventId!,
					score: 0.5,
					similarity: 0.77,
					reason: "embedding:event:test:0.7700",
				},
			],
			parentEventIds: [],
			sourceKey: "test-action-gate",
		});
		const timeline = store.buildTimeline({ limit: 100 });
		const recalled = timeline.find((event) => event.kind === "memory.recalled");
		const injected = timeline.find((event) => event.kind === "action_gate.injected");

		expect(result.gate?.text).toContain("<akasha_holographic_memory>");
		expect(recalled?.payload.recalledTraceIds).toEqual(expect.any(Array));
		expect(recalled?.payload.recalledEdgeIds).toEqual(expect.any(Array));
		expect(recalled?.payload.activationReasons).toEqual(expect.any(Object));
		expect(recalled?.payload.semanticSeedEventIds).toContain(seedEventId);
		expect(recalled?.payload.semanticSeedReasons).toEqual(expect.any(Object));
		expect(injected?.parentEventIds).toContain(recalled?.eventId);
	});
});

function appendFixtureEvents(store: JsonlAkashaStore, cwd: string): void {
	const session = store.append({
		kind: "session.started",
		sessionId: "session-1",
		streamId: "session:session-1",
		eventTime: "2026-05-12T00:00:00.000Z",
		actor: "system",
		payload: { cwd },
	});
	const user = store.append({
		kind: "message.user.submitted",
		sessionId: "session-1",
		streamId: "session:session-1",
		eventTime: "2026-05-12T00:01:00.000Z",
		actor: "user",
		parentEventIds: [session.eventId],
		payload: { text: "Fix src/foo.ts" },
	});
	const patch = store.append({
		kind: "artifact.patched",
		sessionId: "session-1",
		streamId: "session:session-1",
		eventTime: "2026-05-12T00:02:00.000Z",
		actor: "tool",
		objectId: "src/foo.ts",
		parentEventIds: [user.eventId],
		payload: { path: "src/foo.ts", isError: false },
	});
	store.append({
		kind: "tool.completed",
		sessionId: "session-1",
		streamId: "session:session-1",
		eventTime: "2026-05-12T00:03:00.000Z",
		actor: "tool",
		subjectId: "bash",
		objectId: "bash",
		parentEventIds: [patch.eventId],
		payload: { toolName: "bash", isError: true, summary: "foo test failed in src/foo.ts" },
	});
	store.append({
		kind: "command.executed",
		sessionId: "session-1",
		streamId: "session:session-1",
		eventTime: "2026-05-12T00:04:00.000Z",
		actor: "tool",
		objectId: "npm test src/foo.test.ts",
		payload: { command: "npm test src/foo.test.ts", exitCode: 0, cwd },
	});
	store.append({
		kind: "command.executed",
		sessionId: "session-1",
		streamId: "session:session-1",
		eventTime: "2026-05-12T00:05:00.000Z",
		actor: "tool",
		objectId: "npm test src/foo.test.ts",
		payload: { command: "npm test src/foo.test.ts", exitCode: 0, cwd },
	});
}
