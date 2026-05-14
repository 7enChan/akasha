import type { AkashaGatewayEventWriter } from "./events.js";
import { validateReadableMediaPath } from "./media.js";
import type { AkashaGatewayOutboxStore } from "./outbox-store.js";
import { isRetryableTelegramError, telegramRetryAfterSeconds } from "./telegram-client.js";
import type { AkashaGatewayDeliveryReceipt, AkashaGatewayOutboxEvent, AkashaGatewayPlatformAdapter } from "./types.js";

export interface AkashaGatewayDeliveryDriverOptions {
	outbox: AkashaGatewayOutboxStore;
	adapter: AkashaGatewayPlatformAdapter;
	events: AkashaGatewayEventWriter;
}

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
		try {
			if (sending.kind === "media") {
				const mediaResult = await this.deliverMedia(sending);
				if (mediaResult === "dead_lettered") return;
				this.markSent(sending, mediaResult);
				return;
			}
			const receipt = await this.options.adapter.sendMessage({
				chatId: sending.target.chatId,
				text: sending.text ?? "",
			});
			this.markSent(sending, receipt);
		} catch (error) {
			this.markDeliveryFailure(sending, error);
		}
	}

	private async deliverMedia(
		record: AkashaGatewayOutboxEvent,
	): Promise<AkashaGatewayDeliveryReceipt | undefined | "dead_lettered"> {
		if (!record.filePath) {
			this.markDeadLetter(record, "media outbox item missing filePath");
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
			this.markDeadLetter(record, `Could not send media: ${reason}`);
			return "dead_lettered";
		}
		return this.options.adapter.sendMedia(record.target.chatId, record.filePath, record.caption);
	}

	private markSent(record: AkashaGatewayOutboxEvent, receipt: AkashaGatewayDeliveryReceipt | undefined): void {
		const sent = this.options.outbox.markSent(record.outboxId, receipt);
		this.options.events.appendGateway(sent.target.platform, {
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
	}

	private markDeliveryFailure(record: AkashaGatewayOutboxEvent, error: unknown): void {
		const reason = errorMessage(error);
		const failed = isRetryableTelegramError(error)
			? this.options.outbox.markFailed(record.outboxId, reason, telegramRetryAfterSeconds(error))
			: this.options.outbox.markDeadLetter(record.outboxId, reason);
		this.options.events.appendGateway(record.target.platform, {
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
		if (failed.state === "dead_letter") {
			this.emitDeadLetter(failed);
		}
	}

	private markDeadLetter(record: AkashaGatewayOutboxEvent, reason: string): void {
		const dead = this.options.outbox.markDeadLetter(record.outboxId, reason);
		this.options.events.appendGateway(record.target.platform, {
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
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
