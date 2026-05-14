import { describe, expect, it } from "vitest";
import {
	AkashaActionSurfaceRegistry,
	createAkashaActionSurfaceOutcomeDraft,
	createAkashaActionSurfaceRequestedDraft,
	evaluateAkashaActionSurfaceRequest,
} from "../src/core/akasha/action-surface.js";
import { validateAkashaEventStrict } from "../src/core/akasha/schema.js";
import type { AkashaEvent, AkashaEventDraft } from "../src/core/akasha/types.js";

describe("Akasha action surface", () => {
	it("maps declared capabilities to runtime policy actions", () => {
		const registry = new AkashaActionSurfaceRegistry([
			{
				surfaceId: "local-coding",
				kind: "coding",
				label: "Local coding session",
				capabilities: [
					{
						capabilityId: "read_project",
						title: "Read project files",
						risk: "low",
						actions: ["read"],
					},
					{
						capabilityId: "write_project",
						title: "Modify project files",
						risk: "critical",
						actions: ["edit"],
					},
				],
			},
		]);

		const readResolution = registry.resolve({
			surfaceId: "local-coding",
			capabilityId: "read_project",
			actionId: "read",
			objectId: "packages/coding-agent/src/core/akasha/action-surface.ts",
		});
		expect(readResolution.missingCapability).toBe(false);
		expect(evaluateAkashaActionSurfaceRequest(readResolution)).toMatchObject({
			action: "allow",
		});

		const missingResolution = registry.resolve({
			surfaceId: "local-coding",
			capabilityId: "shell_access",
			actionId: "run",
		});
		expect(missingResolution.missingCapability).toBe(true);
		expect(evaluateAkashaActionSurfaceRequest(missingResolution)).toMatchObject({
			action: "block",
			ruleId: "block_surface_missing_capability",
		});

		const criticalResolution = registry.resolve({
			surfaceId: "local-coding",
			capabilityId: "write_project",
			actionId: "edit",
		});
		expect(evaluateAkashaActionSurfaceRequest(criticalResolution)).toMatchObject({
			action: "require_confirmation",
			ruleId: "require_confirmation_for_critical_surface_action",
		});
	});

	it("creates strict audit event drafts for surface requests and outcomes", () => {
		const registry = new AkashaActionSurfaceRegistry([
			{
				surfaceId: "gateway-telegram",
				kind: "gateway",
				label: "Telegram gateway",
				capabilities: [
					{
						capabilityId: "send_message",
						title: "Send a gateway reply",
						risk: "medium",
						actions: ["reply"],
					},
				],
			},
		]);
		const resolution = registry.resolve({
			requestId: "req-1",
			surfaceId: "gateway-telegram",
			capabilityId: "send_message",
			actionId: "reply",
			objectId: "telegram:chat-1",
			payload: { textLength: 42 },
		});
		const requested = materialize(
			1,
			createAkashaActionSurfaceRequestedDraft(
				{
					sessionId: "session-1",
					streamId: "stream-1",
					eventTime: "2026-05-14T12:00:00.000Z",
					sourceEventIds: ["evt-user"],
				},
				resolution,
			),
		);
		const completed = materialize(
			2,
			createAkashaActionSurfaceOutcomeDraft(
				{
					sessionId: "session-1",
					streamId: "stream-1",
					eventTime: "2026-05-14T12:00:01.000Z",
				},
				{
					request: resolution.request,
					resolution,
					requestedEventId: requested.eventId,
					succeeded: true,
					summary: "Sent Telegram reply",
					resultPayload: { messageId: "42" },
				},
			),
		);

		expect(validateAkashaEventStrict(requested)).toEqual([]);
		expect(validateAkashaEventStrict(completed)).toEqual([]);
		expect(completed.parentEventIds).toEqual([requested.eventId]);
		expect(completed.payload).toMatchObject({
			surfaceId: "gateway-telegram",
			capabilityId: "send_message",
			actionId: "reply",
			succeeded: true,
		});
	});
});

function materialize(sequence: number, draft: AkashaEventDraft): AkashaEvent {
	return {
		eventId: draft.eventId ?? `evt-${sequence}`,
		kind: draft.kind,
		sessionId: draft.sessionId,
		streamId: draft.streamId,
		sequence,
		eventTime: draft.eventTime,
		recordedTime: draft.recordedTime ?? draft.eventTime,
		actor: draft.actor,
		subjectId: draft.subjectId,
		objectId: draft.objectId,
		toolCallId: draft.toolCallId,
		sourceKey: draft.sourceKey,
		parentEventIds: draft.parentEventIds ?? [],
		correlationId: draft.correlationId,
		payload: draft.payload ?? {},
		importance: draft.importance ?? 0.5,
		ttlPolicy: draft.ttlPolicy ?? "session",
		version: 1,
	};
}
