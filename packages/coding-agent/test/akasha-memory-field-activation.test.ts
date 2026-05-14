import { describe, expect, it } from "vitest";
import { buildAkashaMemoryCue } from "../src/core/akasha/memory-cue.js";
import { activateAkashaMemoryField } from "../src/core/akasha/memory-field-activation.js";
import { buildAkashaMemoryTraces } from "../src/core/akasha/memory-trace.js";
import { buildAkashaMemoryTraceEdges } from "../src/core/akasha/memory-trace-edge.js";
import type { AkashaEvent } from "../src/core/akasha/types.js";

describe("Akasha memory field activation", () => {
	it("spreads artifact activation into related failure and validation traces", () => {
		const events = [
			event(1, "message.user.submitted", { text: "Fix src/foo.ts" }, { actor: "user" }),
			event(2, "artifact.patched", { path: "src/foo.ts", isError: false }, { objectId: "src/foo.ts" }),
			event(3, "tool.completed", {
				toolName: "bash",
				isError: true,
				summary: "foo test failed",
				path: "src/foo.ts",
			}),
			event(4, "command.executed", {
				command: "npm test src/foo.ts",
				exitCode: 0,
				path: "src/foo.ts",
			}),
		];
		const traces = buildAkashaMemoryTraces(events);
		const edges = buildAkashaMemoryTraceEdges(events, traces);
		const cue = buildAkashaMemoryCue({
			latestUserText: "Continue src/foo.ts",
			cwd: "/repo",
			sessionEvents: events,
		});

		const result = activateAkashaMemoryField(traces, edges, cue, { maxResults: 24, now: new Date(5000) });
		const failureScore = result.scores.find((score) => score.trace.kind === "failure");
		const successScore = result.scores.find((score) => score.trace.kind === "success");

		expect(result.activatedEdgeIds.length).toBeGreaterThan(0);
		expect(result.activationPaths.some((path) => path.edgeKind === "same_artifact")).toBe(true);
		expect(failureScore?.reasons.some((reason) => reason.startsWith("field:same_artifact"))).toBe(true);
		expect(successScore?.reasons.some((reason) => reason.startsWith("field:same_artifact"))).toBe(true);
	});

	it("activates callback lifecycle traces across due and closure events", () => {
		const due = event(1, "time.callback.due", {
			callbackId: "callback-1",
			kind: "promise_due",
			summary: "Review promised validation",
			targetEventId: "promise-1",
		});
		const completed = event(
			2,
			"time.callback.completed",
			{
				callbackId: "callback-1",
				summary: "Promise was resolved after validation",
				targetEventId: "promise-1",
			},
			{ parentEventIds: [due.eventId] },
		);
		const events = [due, completed];
		const traces = buildAkashaMemoryTraces(events);
		const edges = buildAkashaMemoryTraceEdges(events, traces);
		const cue = buildAkashaMemoryCue({
			latestUserText: "Check callback-1",
			cwd: "/repo",
			sessionEvents: events,
		});

		const result = activateAkashaMemoryField(traces, edges, cue, { maxResults: 12, now: new Date(3000) });

		expect(result.activationPaths.some((path) => path.edgeKind === "same_callback")).toBe(true);
		expect(result.scores.some((score) => score.trace.eventId === due.eventId)).toBe(true);
		expect(
			result.scores.some((score) => score.trace.eventId === completed.eventId && score.trace.kind === "closure"),
		).toBe(true);
	});

	it("uses supersession edges to suppress older traces and lift newer traces", () => {
		const oldMemory = event(
			1,
			"message.user.submitted",
			{ text: "Use port 3000 for the dev server" },
			{ actor: "user" },
		);
		const newMemory = event(
			2,
			"message.user.submitted",
			{ text: "Actually use port 4000 for the dev server" },
			{ actor: "user" },
		);
		const reconsolidated = event(
			3,
			"memory.reconsolidated",
			{
				oldMemoryEventId: oldMemory.eventId,
				newMemoryEventId: newMemory.eventId,
				reason: "user_correction_after_recall",
				sourceEventIds: [oldMemory.eventId, newMemory.eventId],
			},
			{ parentEventIds: [oldMemory.eventId, newMemory.eventId] },
		);
		const events = [oldMemory, newMemory, reconsolidated];
		const traces = buildAkashaMemoryTraces(events);
		const edges = buildAkashaMemoryTraceEdges(events, traces);
		const cue = buildAkashaMemoryCue({
			latestUserText: "Which dev server port should be used?",
			cwd: "/repo",
			sessionEvents: events,
		});

		const result = activateAkashaMemoryField(traces, edges, cue, { maxResults: 24, now: new Date(4000) });
		const oldBest = bestEventScore(result.scores, oldMemory.eventId);
		const newBest = bestEventScore(result.scores, newMemory.eventId);

		expect(result.activationPaths.some((path) => path.edgeKind === "supersedes" && path.delta < 0)).toBe(true);
		expect(result.activationPaths.some((path) => path.edgeKind === "supersedes" && path.delta > 0)).toBe(true);
		expect(newBest).toBeGreaterThan(oldBest);
	});

	it("uses semantic seeds as initial activation without creating semantic edges", () => {
		const artifact = event(1, "artifact.patched", {
			path: "src/semantic.ts",
			summary: "semantic adapter changed",
		});
		const failure = event(
			2,
			"tool.completed",
			{
				toolName: "bash",
				isError: true,
				summary: "semantic adapter typecheck failed",
				path: "src/semantic.ts",
			},
			{ parentEventIds: [artifact.eventId] },
		);
		const events = [artifact, failure];
		const traces = buildAkashaMemoryTraces(events);
		const edges = buildAkashaMemoryTraceEdges(events, traces);
		const cue = buildAkashaMemoryCue({
			latestUserText: "continue unrelated work",
			cwd: "/repo",
			sessionEvents: [],
		});

		const result = activateAkashaMemoryField(traces, edges, cue, {
			maxResults: 12,
			now: new Date(3000),
			semanticSeeds: [
				{
					eventId: artifact.eventId,
					score: 0.55,
					similarity: 0.84,
					reason: "embedding:event:event:evt-1:v1:0.8400",
				},
			],
		});
		const artifactScore = result.scores.find((score) => score.trace.eventId === artifact.eventId);
		const failureScore = result.scores.find((score) => score.trace.eventId === failure.eventId);

		expect(artifactScore?.reasons).toContain("seed:semantic:evt-1:0.55");
		expect(failureScore?.reasons.some((reason) => reason.startsWith("field:same_artifact"))).toBe(true);
		expect(result.activationPaths.some((path) => path.edgeKind === "same_artifact")).toBe(true);
		expect(result.activatedEdgeIds.some((edgeId) => edgeId.includes("semantic"))).toBe(false);
	});

	it("keeps semantic seed activation below direct artifact matches", () => {
		const direct = event(1, "artifact.patched", {
			path: "src/direct.ts",
			summary: "direct path touched",
		});
		const semantic = event(
			2,
			"message.user.submitted",
			{ text: "Remember the quiet migration note" },
			{ actor: "user" },
		);
		const events = [direct, semantic];
		const traces = buildAkashaMemoryTraces(events);
		const edges = buildAkashaMemoryTraceEdges(events, traces);
		const cue = buildAkashaMemoryCue({
			latestUserText: "continue src/direct.ts",
			cwd: "/repo",
			sessionEvents: events,
		});

		const result = activateAkashaMemoryField(traces, edges, cue, {
			maxResults: 12,
			now: new Date(3000),
			semanticSeeds: [
				{
					eventId: semantic.eventId,
					score: 0.65,
					similarity: 1,
					reason: "embedding:event:event:evt-2:v1:1.0000",
				},
			],
		});

		expect(bestEventScore(result.scores, direct.eventId)).toBeGreaterThan(
			bestEventScore(result.scores, semantic.eventId),
		);
		expect(
			result.scores.some(
				(score) =>
					score.trace.eventId === semantic.eventId &&
					score.reasons.some((reason) => reason.startsWith("seed:semantic:evt-2")),
			),
		).toBe(true);
	});

	it("keeps activation output deterministic across rebuilds", () => {
		const events = [
			event(1, "message.user.submitted", { text: "Fix src/foo.ts" }, { actor: "user" }),
			event(2, "tool.completed", {
				toolName: "bash",
				isError: true,
				summary: "foo test failed",
				path: "src/foo.ts",
			}),
		];
		const traces = buildAkashaMemoryTraces(events);
		const edges = buildAkashaMemoryTraceEdges(events, traces);
		const cue = buildAkashaMemoryCue({
			latestUserText: "src/foo.ts",
			cwd: "/repo",
			sessionEvents: events,
		});

		const first = activateAkashaMemoryField(traces, edges, cue, { maxResults: 8, now: new Date(3000) });
		const second = activateAkashaMemoryField(traces, edges, cue, { maxResults: 8, now: new Date(3000) });

		expect(second.scores.map((score) => [score.trace.traceId, score.score])).toEqual(
			first.scores.map((score) => [score.trace.traceId, score.score]),
		);
		expect(second.activatedEdgeIds).toEqual(first.activatedEdgeIds);
		expect(second.clusters).toEqual(first.clusters);
	});
});

function bestEventScore(scores: Array<{ trace: { eventId: string }; score: number }>, eventId: string): number {
	return Math.max(0, ...scores.filter((score) => score.trace.eventId === eventId).map((score) => score.score));
}

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
