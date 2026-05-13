import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlAkashaStore } from "../src/core/akasha/jsonl-store.js";
import { evaluateAkashaRuntimePolicy } from "../src/core/akasha/policy-kernel.js";
import { createAkashaTemporalKernel } from "../src/core/akasha/temporal-kernel.js";

describe("Akasha runtime policy surface", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "akasha-runtime-policy-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("evaluates generic runtime actions", () => {
		const decision = evaluateAkashaRuntimePolicy({
			type: "callback_dispatch",
			subject: "scheduled_callback",
			payload: { callbackId: "callback-1" },
		});

		expect(decision).toMatchObject({
			action: "allow",
			reason: "No Akasha policy rule required intervention.",
		});
	});

	it("blocks callback dispatch when the target is suppressed", () => {
		const decision = evaluateAkashaRuntimePolicy({
			type: "callback_dispatch",
			subject: "scheduled_callback",
			objectId: "event-suppressed",
			payload: { callbackId: "callback-1", targetSuppressed: true },
		});

		expect(decision).toMatchObject({
			action: "block",
			ruleId: "block_callback_dispatch_if_target_suppressed",
		});
	});

	it("requires confirmation before export actions", () => {
		const decision = evaluateAkashaRuntimePolicy({
			type: "export",
			subject: "akasha.export",
		});

		expect(decision).toMatchObject({
			action: "require_confirmation",
			ruleId: "require_confirmation_for_export",
		});
	});

	it("appends policy events for context injection before action gate injection", () => {
		const store = new JsonlAkashaStore(join(tempDir, "events.jsonl"));
		const user = store.append({
			kind: "message.user.submitted",
			sessionId: "session-1",
			streamId: "session:session-1",
			eventTime: "2026-05-12T00:00:00.000Z",
			actor: "user",
			payload: { text: "Implement runtime policy surface" },
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
			parentEventIds: [user.eventId],
			sourceKey: "runtime-policy-context",
		});
		const events = store.buildTimeline({ limit: 20 });
		const policy = events.find((event) => event.kind === "policy.evaluated");

		expect(policy?.payload).toMatchObject({
			actionType: "context_injection",
			decision: "allow",
		});
		expect(result.auditEvent?.parentEventIds).toEqual(expect.arrayContaining([policy?.eventId, user.eventId]));
	});
});

function reflectionOff() {
	return {
		enabled: false,
		minEventsSinceLastReflection: 40,
		minIntervalMinutes: 240,
	};
}
