import { describe, expect, it } from "vitest";
import { validateAkashaEventStrict } from "../src/core/akasha/schema.js";
import type { AkashaEvent, AkashaEventDraft } from "../src/core/akasha/types.js";
import {
	computeAkashaGatewayPresenceStatus,
	createAkashaGatewayIdempotencyKey,
	createAkashaGatewayPresenceId,
	createAkashaGatewayPresenceUpdatedDraft,
	decideAkashaGatewayPairing,
	projectAkashaGatewayPresence,
	recordAkashaGatewayHeartbeat,
} from "../src/gateway/presence.js";

describe("Akasha gateway presence", () => {
	it("creates stable presence identities and idempotency keys", () => {
		expect(
			createAkashaGatewayPresenceId({
				role: "node",
				platform: "telegram",
				externalId: "chat-123",
			}),
		).toBe(
			createAkashaGatewayPresenceId({
				role: "node",
				platform: "telegram",
				externalId: "chat-123",
			}),
		);
		expect(createAkashaGatewayIdempotencyKey("send", ["telegram", "chat-1", "message-1"])).toBe(
			createAkashaGatewayIdempotencyKey("send", ["telegram", "chat-1", "message-1"]),
		);
		expect(createAkashaGatewayIdempotencyKey("send", ["telegram", "chat-1", "message-1"])).not.toBe(
			createAkashaGatewayIdempotencyKey("send", ["telegram", "chat-1", "message-2"]),
		);
	});

	it("decides pairing and computes heartbeat freshness", () => {
		const local = decideAkashaGatewayPairing({
			role: "node",
			platform: "telegram",
			externalId: "chat-1",
			label: "Telegram chat node",
			localLoopback: true,
			allowLocalAutoPair: true,
			now: "2026-05-14T12:00:00.000Z",
			capabilities: [
				{
					capabilityId: "send_message",
					description: "Send Telegram messages",
					risk: "medium",
				},
			],
		});
		expect(local.action).toBe("approve");
		expect(local.presence.status).toBe("paired");

		const online = recordAkashaGatewayHeartbeat(local.presence, "2026-05-14T12:00:10.000Z");
		expect(online.status).toBe("online");
		expect(computeAkashaGatewayPresenceStatus(online, "2026-05-14T12:00:20.000Z", 20_000)).toBe("online");
		expect(computeAkashaGatewayPresenceStatus(online, "2026-05-14T12:01:00.000Z", 20_000)).toBe("stale");

		const remote = decideAkashaGatewayPairing({
			role: "device",
			label: "Remote laptop",
			capabilities: [{ capabilityId: "run_agent", risk: "critical" }],
			now: "2026-05-14T12:00:00.000Z",
		});
		expect(remote.action).toBe("require_approval");
		expect(remote.presence.status).toBe("pending_pairing");
	});

	it("creates strict presence audit events and projects latest presence", () => {
		const decision = decideAkashaGatewayPairing({
			role: "gateway",
			platform: "telegram",
			externalId: "bot",
			label: "Telegram gateway",
			presentedToken: "secret",
			trustedTokens: ["secret"],
			now: "2026-05-14T12:00:00.000Z",
			capabilities: [{ capabilityId: "receive_message", risk: "low" }],
		});
		const paired = materialize(
			1,
			createAkashaGatewayPresenceUpdatedDraft(
				{
					sessionId: "gateway:telegram",
					streamId: "gateway:telegram",
					eventTime: "2026-05-14T12:00:00.000Z",
				},
				decision.presence,
			),
		);
		const onlinePresence = recordAkashaGatewayHeartbeat(decision.presence, "2026-05-14T12:00:30.000Z");
		const online = materialize(
			2,
			createAkashaGatewayPresenceUpdatedDraft(
				{
					sessionId: "gateway:telegram",
					streamId: "gateway:telegram",
					eventTime: "2026-05-14T12:00:30.000Z",
					parentEventIds: [paired.eventId],
				},
				onlinePresence,
			),
		);

		expect(validateAkashaEventStrict(paired)).toEqual([]);
		expect(validateAkashaEventStrict(online)).toEqual([]);
		const projected = projectAkashaGatewayPresence([paired, online]);
		expect(projected.get(decision.presence.presenceId)).toMatchObject({
			status: "online",
			lastSeenAt: "2026-05-14T12:00:30.000Z",
			capabilities: [{ capabilityId: "receive_message", risk: "low" }],
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
