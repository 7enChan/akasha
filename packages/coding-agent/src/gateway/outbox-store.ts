import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AkashaGatewayDeliveryReceipt, AkashaGatewayDeliveryTarget, AkashaGatewayOutboxEvent } from "./types.js";

export const AKASHA_GATEWAY_OUTBOX_MAX_ATTEMPTS = 5;
export const AKASHA_GATEWAY_OUTBOX_SENDING_LEASE_MS = 10 * 60 * 1000;

const OUTBOX_RETRY_DELAYS_MS = [1000, 5000, 30_000, 2 * 60_000, 10 * 60_000] as const;

export interface AkashaGatewayOutboxEnqueueTextInput {
	target: AkashaGatewayDeliveryTarget;
	text: string;
	outboxId?: string;
	sourceMessageKey?: string;
	sourceEventId?: string;
	now?: Date;
}

export interface AkashaGatewayOutboxEnqueueMediaInput {
	target: AkashaGatewayDeliveryTarget;
	filePath: string;
	caption?: string;
	outboxId?: string;
	sourceMessageKey?: string;
	sourceEventId?: string;
	now?: Date;
}

export interface AkashaGatewayOutboxCounts {
	pending: number;
	deadLetters: number;
}

export class AkashaGatewayOutboxStore {
	constructor(private readonly agentDir: string) {}

	enqueueText(input: AkashaGatewayOutboxEnqueueTextInput): { record: AkashaGatewayOutboxEvent; enqueued: boolean } {
		const outboxId = input.outboxId ?? deriveOutboxId("text", input.target, input.text, input.sourceMessageKey);
		const existing = this.project().get(outboxId);
		if (existing) return { record: existing, enqueued: false };
		const record: AkashaGatewayOutboxEvent = {
			recordType: "gateway.outbox",
			outboxId,
			target: input.target,
			kind: "text",
			state: "queued",
			attempt: 0,
			eventTime: (input.now ?? new Date()).toISOString(),
			text: input.text,
			sourceMessageKey: input.sourceMessageKey,
			sourceEventId: input.sourceEventId,
		};
		this.append(record);
		return { record, enqueued: true };
	}

	enqueueMedia(input: AkashaGatewayOutboxEnqueueMediaInput): { record: AkashaGatewayOutboxEvent; enqueued: boolean } {
		const outboxId =
			input.outboxId ??
			deriveOutboxId("media", input.target, `${input.filePath}\n${input.caption ?? ""}`, input.sourceMessageKey);
		const existing = this.project().get(outboxId);
		if (existing) return { record: existing, enqueued: false };
		const record: AkashaGatewayOutboxEvent = {
			recordType: "gateway.outbox",
			outboxId,
			target: input.target,
			kind: "media",
			state: "queued",
			attempt: 0,
			eventTime: (input.now ?? new Date()).toISOString(),
			filePath: input.filePath,
			caption: input.caption,
			sourceMessageKey: input.sourceMessageKey,
			sourceEventId: input.sourceEventId,
		};
		this.append(record);
		return { record, enqueued: true };
	}

	markSending(outboxId: string, now = new Date()): AkashaGatewayOutboxEvent {
		const current = this.requireRecord(outboxId);
		const record = this.copyWith(current, {
			state: "sending",
			attempt: current.attempt + 1,
			eventTime: now.toISOString(),
			nextAttemptAt: new Date(now.getTime() + AKASHA_GATEWAY_OUTBOX_SENDING_LEASE_MS).toISOString(),
			error: undefined,
		});
		this.append(record);
		return record;
	}

	markSent(
		outboxId: string,
		receipt: AkashaGatewayDeliveryReceipt | undefined,
		now = new Date(),
	): AkashaGatewayOutboxEvent {
		const current = this.requireRecord(outboxId);
		const record = this.copyWith(current, {
			state: "sent",
			eventTime: now.toISOString(),
			nextAttemptAt: undefined,
			telegramMessageId: receipt?.messageId,
			error: undefined,
		});
		this.append(record);
		return record;
	}

	markFailed(
		outboxId: string,
		error: string,
		retryAfterSeconds: number | undefined,
		now = new Date(),
	): AkashaGatewayOutboxEvent {
		const current = this.requireRecord(outboxId);
		if (current.attempt >= AKASHA_GATEWAY_OUTBOX_MAX_ATTEMPTS) {
			return this.markDeadLetter(outboxId, error, now);
		}
		const delayMs = retryDelayMs(current.attempt, retryAfterSeconds);
		const record = this.copyWith(current, {
			state: "failed",
			eventTime: now.toISOString(),
			nextAttemptAt: new Date(now.getTime() + delayMs).toISOString(),
			error,
		});
		this.append(record);
		return record;
	}

	markDeadLetter(outboxId: string, error: string, now = new Date()): AkashaGatewayOutboxEvent {
		const current = this.requireRecord(outboxId);
		const record = this.copyWith(current, {
			state: "dead_letter",
			eventTime: now.toISOString(),
			nextAttemptAt: undefined,
			error,
		});
		this.append(record);
		return record;
	}

	listDue(now = new Date()): AkashaGatewayOutboxEvent[] {
		const nowMs = now.getTime();
		return [...this.project().values()]
			.filter((record) => {
				if (record.state === "queued") return true;
				if (record.state !== "failed" && record.state !== "sending") return false;
				if (record.attempt >= AKASHA_GATEWAY_OUTBOX_MAX_ATTEMPTS && record.state !== "sending") return false;
				if (!record.nextAttemptAt) return true;
				return Date.parse(record.nextAttemptAt) <= nowMs;
			})
			.sort(compareOutboxRecords);
	}

	project(): Map<string, AkashaGatewayOutboxEvent> {
		const records = new Map<string, AkashaGatewayOutboxEvent>();
		for (const record of this.readRecords()) {
			const current = records.get(record.outboxId);
			records.set(record.outboxId, current ? mergeOutboxRecord(current, record) : record);
		}
		return records;
	}

	counts(): AkashaGatewayOutboxCounts {
		let pending = 0;
		let deadLetters = 0;
		for (const record of this.project().values()) {
			if (record.state === "dead_letter") {
				deadLetters++;
				continue;
			}
			if (record.state !== "sent") pending++;
		}
		return { pending, deadLetters };
	}

	private append(record: AkashaGatewayOutboxEvent): void {
		mkdirSync(dirname(this.path), { recursive: true });
		appendFileSync(this.path, `${JSON.stringify(record)}\n`, "utf-8");
	}

	private readRecords(): AkashaGatewayOutboxEvent[] {
		if (!existsSync(this.path)) return [];
		return readFileSync(this.path, "utf-8")
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.flatMap((line) => {
				try {
					const parsed = JSON.parse(line) as unknown;
					return isOutboxRecord(parsed) ? [parsed] : [];
				} catch {
					return [];
				}
			});
	}

	private requireRecord(outboxId: string): AkashaGatewayOutboxEvent {
		const record = this.project().get(outboxId);
		if (!record) throw new Error(`Gateway outbox record not found: ${outboxId}`);
		return record;
	}

	private copyWith(
		current: AkashaGatewayOutboxEvent,
		update: Partial<AkashaGatewayOutboxEvent> & Pick<AkashaGatewayOutboxEvent, "state" | "eventTime">,
	): AkashaGatewayOutboxEvent {
		return {
			recordType: "gateway.outbox",
			outboxId: current.outboxId,
			target: update.target ?? current.target,
			kind: update.kind ?? current.kind,
			state: update.state,
			attempt: update.attempt ?? current.attempt,
			eventTime: update.eventTime,
			text: update.text ?? current.text,
			filePath: update.filePath ?? current.filePath,
			caption: update.caption ?? current.caption,
			nextAttemptAt: update.nextAttemptAt,
			telegramMessageId: update.telegramMessageId ?? current.telegramMessageId,
			error: update.error,
			sourceMessageKey: update.sourceMessageKey ?? current.sourceMessageKey,
			sourceEventId: update.sourceEventId ?? current.sourceEventId,
		};
	}

	private get path(): string {
		return resolveAkashaGatewayOutboxPath(this.agentDir);
	}
}

export function resolveAkashaGatewayOutboxPath(agentDir: string): string {
	return join(agentDir, "gateway", "outbox.jsonl");
}

export function retryDelayMs(attempt: number, retryAfterSeconds: number | undefined): number {
	if (typeof retryAfterSeconds === "number" && Number.isFinite(retryAfterSeconds)) {
		return Math.max(1000, Math.floor(retryAfterSeconds * 1000));
	}
	const index = Math.max(0, Math.min(OUTBOX_RETRY_DELAYS_MS.length - 1, attempt - 1));
	return OUTBOX_RETRY_DELAYS_MS[index];
}

function deriveOutboxId(
	kind: AkashaGatewayOutboxEvent["kind"],
	target: AkashaGatewayDeliveryTarget,
	payload: string,
	sourceMessageKey: string | undefined,
): string {
	const hash = createHash("sha256")
		.update(kind)
		.update("\0")
		.update(target.platform)
		.update("\0")
		.update(target.chatId)
		.update("\0")
		.update(sourceMessageKey ?? "")
		.update("\0")
		.update(payload)
		.digest("hex")
		.slice(0, 24);
	return `gateway-outbox:${kind}:${hash}`;
}

function mergeOutboxRecord(
	current: AkashaGatewayOutboxEvent,
	next: AkashaGatewayOutboxEvent,
): AkashaGatewayOutboxEvent {
	return {
		...next,
		target: next.target ?? current.target,
		kind: next.kind ?? current.kind,
		text: next.text ?? current.text,
		filePath: next.filePath ?? current.filePath,
		caption: next.caption ?? current.caption,
		telegramMessageId: next.telegramMessageId ?? current.telegramMessageId,
		sourceMessageKey: next.sourceMessageKey ?? current.sourceMessageKey,
		sourceEventId: next.sourceEventId ?? current.sourceEventId,
	};
}

function compareOutboxRecords(a: AkashaGatewayOutboxEvent, b: AkashaGatewayOutboxEvent): number {
	return Date.parse(a.eventTime) - Date.parse(b.eventTime) || a.outboxId.localeCompare(b.outboxId);
}

function isOutboxRecord(value: unknown): value is AkashaGatewayOutboxEvent {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		record.recordType === "gateway.outbox" &&
		typeof record.outboxId === "string" &&
		typeof record.target === "object" &&
		record.target !== null &&
		!Array.isArray(record.target) &&
		(record.kind === "text" || record.kind === "media") &&
		isOutboxState(record.state) &&
		typeof record.attempt === "number" &&
		typeof record.eventTime === "string"
	);
}

function isOutboxState(value: unknown): value is AkashaGatewayOutboxEvent["state"] {
	return (
		value === "queued" || value === "sending" || value === "sent" || value === "failed" || value === "dead_letter"
	);
}
