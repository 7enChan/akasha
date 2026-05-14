import {
	type AkashaActionSurface,
	type AkashaResolvedActionSurfaceRequest,
	buildAkashaActionSurfacePolicyAction,
	createAkashaActionSurfaceOutcomeDraft,
	createAkashaActionSurfaceRequestedDraft,
	evaluateAkashaActionSurfaceRequest,
	resolveAkashaActionSurfaceRequest,
} from "../core/akasha/action-surface.js";
import { createPolicyEvaluatedPayload } from "../core/akasha/policy-kernel.js";
import type { AkashaEvent, AkashaEventDraft } from "../core/akasha/types.js";
import type { AkashaGatewayEventWriter } from "./events.js";
import { validateReadableMediaPath } from "./media.js";
import type { AkashaGatewayOutboxStore } from "./outbox-store.js";
import {
	createAkashaGatewayIdempotencyKey,
	createAkashaGatewayPresenceId,
	createAkashaGatewayPresenceUpdatedDraft,
	recordAkashaGatewayHeartbeat,
} from "./presence.js";
import { isRetryableTelegramError, telegramRetryAfterSeconds } from "./telegram-client.js";
import type { AkashaGatewayDeliveryReceipt, AkashaGatewayOutboxEvent, AkashaGatewayPlatformAdapter } from "./types.js";

export interface AkashaGatewayDeliveryDriverOptions {
	outbox: AkashaGatewayOutboxStore;
	adapter: AkashaGatewayPlatformAdapter;
	events: AkashaGatewayEventWriter;
}

interface AkashaGatewayDeliverySurfaceAudit {
	resolution: AkashaResolvedActionSurfaceRequest;
	requestedEventId: string;
	policyEventId?: string;
}

const GATEWAY_DELIVERY_CAPABILITIES = [
	{
		capabilityId: "send_text",
		title: "Send gateway text messages",
		risk: "medium" as const,
		actions: ["send_message"],
	},
	{
		capabilityId: "send_media",
		title: "Send gateway media attachments",
		risk: "high" as const,
		actions: ["send_media"],
	},
];

export class AkashaGatewayDeliveryDriver {
	constructor(private readonly options: AkashaGatewayDeliveryDriverOptions) {}

	async drainDue(now = new Date()): Promise<void> {
		for (let pass = 0; pass < 10; pass++) {
			const due = this.options.outbox.listDue(now);
			if (due.length === 0) return;
			for (const record of due) {
				await this.deliverOne(record);
			}
		}
	}

	private async deliverOne(record: AkashaGatewayOutboxEvent): Promise<void> {
		if (record.state === "sent") return;
		const sending = this.options.outbox.markSending(record.outboxId);
		const surfaceAudit = this.appendDeliverySurfaceRequest(sending);
		const surfaceDecision = evaluateAkashaActionSurfaceRequest(surfaceAudit.resolution);
		if (surfaceDecision.action !== "allow") {
			this.markDeadLetter(sending, surfaceDecision.reason, surfaceAudit);
			return;
		}
		try {
			if (sending.kind === "media") {
				const mediaResult = await this.deliverMedia(sending, surfaceAudit);
				if (mediaResult === "dead_lettered") return;
				this.markSent(sending, mediaResult, surfaceAudit);
				return;
			}
			const receipt = await this.options.adapter.sendMessage({
				chatId: sending.target.chatId,
				text: sending.text ?? "",
			});
			this.markSent(sending, receipt, surfaceAudit);
		} catch (error) {
			this.markDeliveryFailure(sending, error, surfaceAudit);
		}
	}

	private async deliverMedia(
		record: AkashaGatewayOutboxEvent,
		surfaceAudit: AkashaGatewayDeliverySurfaceAudit,
	): Promise<AkashaGatewayDeliveryReceipt | undefined | "dead_lettered"> {
		if (!record.filePath) {
			this.markDeadLetter(record, "media outbox item missing filePath", surfaceAudit);
			return "dead_lettered";
		}
		const readable = validateReadableMediaPath(record.filePath);
		if (!readable.ok || !this.options.adapter.sendMedia) {
			const reason = readable.ok ? "adapter does not support media" : readable.reason;
			this.options.outbox.enqueueText({
				target: record.target,
				outboxId: `${record.outboxId}:failure-notice`,
				sourceMessageKey: record.sourceMessageKey,
				sourceEventId: record.sourceEventId,
				text: `Could not send media ${record.filePath}: ${reason}`,
			});
			this.markDeadLetter(record, `Could not send media: ${reason}`, surfaceAudit);
			return "dead_lettered";
		}
		return this.options.adapter.sendMedia(record.target.chatId, record.filePath, record.caption);
	}

	private markSent(
		record: AkashaGatewayOutboxEvent,
		receipt: AkashaGatewayDeliveryReceipt | undefined,
		surfaceAudit: AkashaGatewayDeliverySurfaceAudit,
	): void {
		const sent = this.options.outbox.markSent(record.outboxId, receipt);
		const sentEvent = this.options.events.appendGateway(sent.target.platform, {
			kind: "gateway.outbox.sent",
			subjectId: "akasha.gateway.outbox",
			objectId: sent.outboxId,
			sourceKey: `gateway-outbox-sent:${sent.outboxId}`,
			payload: {
				outboxId: sent.outboxId,
				chatId: sent.target.chatId,
				kind: sent.kind,
				attempt: sent.attempt,
				telegramMessageId: sent.telegramMessageId,
				sourceMessageKey: sent.sourceMessageKey,
			},
			ttlPolicy: "long_term",
			importance: 0.65,
		});
		this.appendDeliverySurfaceOutcome(record, surfaceAudit, true, "Gateway outbox delivery succeeded.", sentEvent);
	}

	private markDeliveryFailure(
		record: AkashaGatewayOutboxEvent,
		error: unknown,
		surfaceAudit: AkashaGatewayDeliverySurfaceAudit,
	): void {
		const reason = errorMessage(error);
		const failed = isRetryableTelegramError(error)
			? this.options.outbox.markFailed(record.outboxId, reason, telegramRetryAfterSeconds(error))
			: this.options.outbox.markDeadLetter(record.outboxId, reason);
		const failureEvent = this.options.events.appendGateway(record.target.platform, {
			kind: "gateway.delivery.failed",
			subjectId: "akasha.gateway.outbox",
			objectId: record.outboxId,
			sourceKey: `gateway-delivery-failed:${record.outboxId}:${record.attempt}`,
			payload: {
				outboxId: record.outboxId,
				chatId: record.target.chatId,
				kind: record.kind,
				attempt: record.attempt,
				reason,
				nextAttemptAt: failed.nextAttemptAt,
				state: failed.state,
				sourceMessageKey: record.sourceMessageKey,
			},
			ttlPolicy: "long_term",
			importance: failed.state === "dead_letter" ? 0.9 : 0.75,
		});
		this.appendDeliverySurfaceOutcome(record, surfaceAudit, false, reason, failureEvent);
		if (failed.state === "dead_letter") {
			this.emitDeadLetter(failed);
		}
	}

	private markDeadLetter(
		record: AkashaGatewayOutboxEvent,
		reason: string,
		surfaceAudit: AkashaGatewayDeliverySurfaceAudit,
	): void {
		const dead = this.options.outbox.markDeadLetter(record.outboxId, reason);
		const failureEvent = this.options.events.appendGateway(record.target.platform, {
			kind: "gateway.delivery.failed",
			subjectId: "akasha.gateway.outbox",
			objectId: record.outboxId,
			sourceKey: `gateway-delivery-failed:${record.outboxId}:${record.attempt}`,
			payload: {
				outboxId: record.outboxId,
				chatId: record.target.chatId,
				kind: record.kind,
				attempt: record.attempt,
				reason,
				state: dead.state,
				sourceMessageKey: record.sourceMessageKey,
			},
			ttlPolicy: "long_term",
			importance: 0.9,
		});
		this.appendDeliverySurfaceOutcome(record, surfaceAudit, false, reason, failureEvent);
		this.emitDeadLetter(dead);
	}

	private emitDeadLetter(record: AkashaGatewayOutboxEvent): void {
		this.options.events.appendGateway(record.target.platform, {
			kind: "gateway.outbox.dead_letter",
			subjectId: "akasha.gateway.outbox",
			objectId: record.outboxId,
			sourceKey: `gateway-outbox-dead-letter:${record.outboxId}`,
			payload: {
				outboxId: record.outboxId,
				chatId: record.target.chatId,
				kind: record.kind,
				attempt: record.attempt,
				error: record.error,
				sourceMessageKey: record.sourceMessageKey,
			},
			ttlPolicy: "long_term",
			importance: 0.9,
		});
	}

	private appendDeliverySurfaceRequest(record: AkashaGatewayOutboxEvent): AkashaGatewayDeliverySurfaceAudit {
		const now = new Date().toISOString();
		const presence = this.appendGatewayPresence(record, now);
		const surface = gatewayDeliverySurface(record);
		const resolution = resolveAkashaActionSurfaceRequest([surface], {
			requestId: record.outboxId,
			surfaceId: surface.surfaceId,
			capabilityId: record.kind === "media" ? "send_media" : "send_text",
			actionId: record.kind === "media" ? "send_media" : "send_message",
			subject: "akasha.gateway.outbox",
			objectId: `${record.target.platform}:${record.target.chatId}:${record.outboxId}`,
			payload: {
				outboxId: record.outboxId,
				kind: record.kind,
				target: record.target,
				sourceMessageKey: record.sourceMessageKey,
				idempotencyKey: createAkashaGatewayIdempotencyKey("outbox-delivery", [
					record.target.platform,
					record.target.chatId,
					record.outboxId,
					record.attempt,
				]),
			},
		});
		const policyAction = buildAkashaActionSurfacePolicyAction(resolution);
		const decision = evaluateAkashaActionSurfaceRequest(resolution);
		const policy = this.options.events.appendGateway(record.target.platform, {
			kind: "policy.evaluated",
			subjectId: "akasha.policy_kernel",
			objectId: policyAction.objectId ?? policyAction.subject,
			sourceKey: `gateway-outbox-surface-policy:${record.outboxId}:${record.attempt}`,
			parentEventIds: presence ? [presence.eventId] : [],
			payload: createPolicyEvaluatedPayload(
				{
					actionType: policyAction.type,
					subject: policyAction.subject,
					objectId: policyAction.objectId,
					payload: policyAction.payload,
					evidenceEvents: policyAction.evidenceEvents,
					rules: policyAction.rules,
					now: new Date(now),
				},
				decision,
			),
			ttlPolicy: "long_term",
			importance: decision.action === "allow" ? 0.45 : 0.85,
		});
		const requested = this.appendGatewayDraft(
			record.target.platform,
			createAkashaActionSurfaceRequestedDraft(
				{
					sessionId: `gateway:${record.target.platform}`,
					streamId: `gateway:${record.target.platform}`,
					eventTime: now,
					parentEventIds: [policy.eventId],
					sourceEventIds: [policy.eventId],
				},
				resolution,
			),
		);
		return {
			resolution,
			requestedEventId: requested.eventId,
			policyEventId: policy.eventId,
		};
	}

	private appendDeliverySurfaceOutcome(
		record: AkashaGatewayOutboxEvent,
		surfaceAudit: AkashaGatewayDeliverySurfaceAudit,
		succeeded: boolean,
		summary: string,
		outcomeEvent: AkashaEvent,
	): void {
		this.appendGatewayDraft(
			record.target.platform,
			createAkashaActionSurfaceOutcomeDraft(
				{
					sessionId: `gateway:${record.target.platform}`,
					streamId: `gateway:${record.target.platform}`,
					eventTime: new Date().toISOString(),
					parentEventIds: [outcomeEvent.eventId, surfaceAudit.policyEventId].filter(
						(id): id is string => typeof id === "string",
					),
				},
				{
					request: surfaceAudit.resolution.request,
					resolution: surfaceAudit.resolution,
					requestedEventId: surfaceAudit.requestedEventId,
					succeeded,
					summary,
					error: succeeded ? undefined : summary,
					resultPayload: {
						outboxId: record.outboxId,
						state: succeeded ? "sent" : "failed",
						kind: record.kind,
					},
				},
			),
		);
	}

	private appendGatewayPresence(record: AkashaGatewayOutboxEvent, now: string): AkashaEvent {
		const presence = recordAkashaGatewayHeartbeat(
			{
				presenceId: createAkashaGatewayPresenceId({
					role: "gateway",
					platform: record.target.platform,
					externalId: record.target.platform,
					label: `${record.target.platform} gateway`,
				}),
				role: "gateway",
				status: "paired",
				label: `${record.target.platform} gateway`,
				capabilities: GATEWAY_DELIVERY_CAPABILITIES.map((capability) => ({
					capabilityId: capability.capabilityId,
					description: capability.title,
					commands: capability.actions,
					risk: capability.risk,
				})),
				lastSeenAt: now,
				platform: record.target.platform,
			},
			now,
		);
		return this.appendGatewayDraft(
			record.target.platform,
			createAkashaGatewayPresenceUpdatedDraft(
				{
					sessionId: `gateway:${record.target.platform}`,
					streamId: `gateway:${record.target.platform}`,
					eventTime: now,
				},
				presence,
			),
		);
	}

	private appendGatewayDraft(
		platform: AkashaGatewayOutboxEvent["target"]["platform"],
		draft: AkashaEventDraft,
	): AkashaEvent {
		return this.options.events.appendGateway(platform, {
			kind: draft.kind,
			eventTime: draft.eventTime,
			actor: draft.actor,
			subjectId: draft.subjectId,
			objectId: draft.objectId,
			toolCallId: draft.toolCallId,
			sourceKey: draft.sourceKey,
			parentEventIds: draft.parentEventIds,
			correlationId: draft.correlationId,
			payload: draft.payload,
			importance: draft.importance,
			ttlPolicy: draft.ttlPolicy,
		});
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function gatewayDeliverySurface(record: AkashaGatewayOutboxEvent): AkashaActionSurface {
	return {
		surfaceId: `akasha.gateway.${record.target.platform}`,
		kind: "gateway",
		label: `${record.target.platform} gateway delivery`,
		capabilities: GATEWAY_DELIVERY_CAPABILITIES,
		metadata: {
			platform: record.target.platform,
		},
	};
}
