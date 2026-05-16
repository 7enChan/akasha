import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAkashaActionGateContext } from "../src/core/akasha/action-gate.js";
import { buildAkashaClaimLedger, createAkashaClaimKey } from "../src/core/akasha/claim-ledger.js";
import type { AkashaClaimToolContext } from "../src/core/akasha/claim-tools.js";
import { appendAkashaClaim } from "../src/core/akasha/claim-tools.js";
import {
	formatAkashaHolographicMemoryContext,
	reconstructAkashaMemoryField,
} from "../src/core/akasha/holographic-memory.js";
import { JsonlAkashaStore } from "../src/core/akasha/jsonl-store.js";
import { buildAkashaMemoryCue } from "../src/core/akasha/memory-cue.js";
import { buildAkashaMemoryTraces } from "../src/core/akasha/memory-trace.js";
import type { AkashaEvent } from "../src/core/akasha/types.js";

describe("Akasha generic claims", () => {
	let tempDir: string;
	let store: JsonlAkashaStore;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "akasha-claims-"));
		store = new JsonlAkashaStore(join(tempDir, "events.jsonl"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("projects arbitrary subject predicate scope claims without enum membership", () => {
		appendAkashaClaim(claimContext("2026-05-10T00:00:00.000Z", "claim-1"), {
			subject: "user",
			predicate: "works from",
			value: "Beijing",
			scope: "career",
			exclusive: true,
			sourceEventIds: ["evt-source"],
		});

		const ledger = buildAkashaClaimLedger(store.buildTimeline({ limit: 20 }));

		expect(createAkashaClaimKey({ subject: "user", predicate: "works from", scope: "career" })).toBe(
			"user:works_from:career",
		);
		expect(ledger.current[0]).toMatchObject({
			subject: "user",
			predicate: "works from",
			value: "Beijing",
			scope: "career",
			claimKey: "user:works_from:career",
		});
	});

	it("supersedes prior current claims only for exclusive replacement claims", () => {
		appendAkashaClaim(claimContext("2026-05-10T00:00:00.000Z", "claim-beijing"), {
			subject: "user",
			predicate: "work base",
			value: "Beijing",
			scope: "employment",
			exclusive: true,
		});
		appendAkashaClaim(claimContext("2026-05-11T00:00:00.000Z", "claim-shanghai"), {
			subject: "user",
			predicate: "work base",
			value: "Shanghai",
			scope: "employment",
			exclusive: true,
		});

		const events = store.buildTimeline({ limit: 20 });
		const ledger = buildAkashaClaimLedger(events);

		expect(events.map((event) => event.kind)).toEqual(expect.arrayContaining(["claim.observed", "claim.superseded"]));
		expect(ledger.current).toHaveLength(1);
		expect(ledger.current[0]).toMatchObject({ value: "Shanghai", status: "current" });
		expect(ledger.historical[0]).toMatchObject({ value: "Beijing", status: "superseded" });
	});

	it("confirms identical claims and lets non-exclusive values coexist", () => {
		appendAkashaClaim(claimContext("2026-05-10T00:00:00.000Z", "claim-noodles"), {
			subject: "user",
			predicate: "lunch preference",
			value: "noodles",
			scope: "food",
		});
		appendAkashaClaim(claimContext("2026-05-10T00:01:00.000Z", "claim-noodles-again"), {
			subject: "user",
			predicate: "lunch preference",
			value: "noodles",
			scope: "food",
		});
		appendAkashaClaim(claimContext("2026-05-10T00:02:00.000Z", "claim-rice"), {
			subject: "user",
			predicate: "lunch preference",
			value: "rice",
			scope: "food",
		});

		const events = store.buildTimeline({ limit: 20 });
		const ledger = buildAkashaClaimLedger(events);

		expect(events.map((event) => event.kind)).toEqual(expect.arrayContaining(["claim.confirmed"]));
		expect(events.some((event) => event.kind === "claim.superseded")).toBe(false);
		expect(ledger.currentByClaimKey.get("user:lunch_preference:food")?.map((claim) => claim.value)).toEqual([
			"noodles",
			"rice",
		]);
		expect(ledger.confirmed[0]).toMatchObject({ value: "noodles" });
	});

	it("annotates memory formed under superseded exclusive claims as requiring revalidation", () => {
		const initial = appendMessage("2026-05-10T09:00:00.000Z", "My work base is Beijing.");
		appendAkashaClaim(claimContext("2026-05-10T09:01:00.000Z", "claim-beijing"), {
			subject: "user",
			predicate: "work base",
			value: "Beijing",
			scope: "employment",
			summary: "user work base is Beijing",
			exclusive: true,
			sourceEventIds: [initial.eventId],
		});
		appendMessage(
			"2026-05-10T09:02:00.000Z",
			"For Beijing office lunches, the user prefers noodles near the office.",
		);
		const moved = appendMessage("2026-05-12T09:00:00.000Z", "My work base moved to Shanghai.");
		appendAkashaClaim(claimContext("2026-05-12T09:01:00.000Z", "claim-shanghai"), {
			subject: "user",
			predicate: "work base",
			value: "Shanghai",
			scope: "employment",
			summary: "user work base is Shanghai",
			exclusive: true,
			sourceEventIds: [moved.eventId],
		});

		const events = store.buildTimeline({ limit: 50 });
		const cue = buildAkashaMemoryCue({
			latestUserText: "What should I assume about the user's office lunch preference now?",
			sessionEvents: events,
			now: "2026-05-12T10:00:00.000Z",
		});
		const field = reconstructAkashaMemoryField({
			events,
			traces: buildAkashaMemoryTraces(events),
			cue,
			options: { now: new Date("2026-05-12T10:00:00.000Z") },
		});
		const beijingAnnotation = field.contextualValidityAnnotations.find((annotation) =>
			annotation.summary.includes("Beijing"),
		);
		const hml = formatAkashaHolographicMemoryContext(field);
		const gate = buildAkashaActionGateContext({
			sessionEvents: events,
			holographicMemory: field,
			now: "2026-05-12T10:00:00.000Z",
		});

		expect(beijingAnnotation).toMatchObject({
			status: "historical",
			dependency: "explicit",
			useAs: "requires_revalidation",
		});
		expect(hml).toContain("<contextual_validity>");
		expect(hml).toContain("use_as=requires_revalidation");
		expect(gate?.text).toContain("<contextual_validity>");
		expect(gate?.text).toContain("use_as=requires_revalidation");
		expect(beijingAnnotation?.useAs).not.toBe("current_context");
	});

	function claimContext(now: string, toolCallId: string): AkashaClaimToolContext {
		return {
			store,
			sessionId: "session-1",
			streamId: "session:session-1",
			now: () => now,
			parentEventIds: [],
			toolCallId,
			sourceKeyPrefix: "claim-test",
		};
	}

	function appendMessage(eventTime: string, text: string): AkashaEvent {
		return store.append({
			kind: "message.user.submitted",
			sessionId: "session-1",
			streamId: "session:session-1",
			eventTime,
			actor: "user",
			payload: { text },
			importance: 0.7,
			ttlPolicy: "long_term",
		});
	}
});
