import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AkashaGatewayChatState, AkashaGatewayInboxEvent, AkashaGatewayIncomingMessage } from "./types.js";

export const AKASHA_GATEWAY_INBOX_MAX_ATTEMPTS = 3;
export const AKASHA_GATEWAY_INBOX_LEASE_MS = 5 * 60 * 1000;

export interface AkashaGatewayInboxEnqueueInput {
	chat: AkashaGatewayChatState;
	message: AkashaGatewayIncomingMessage;
	messageKey?: string;
	itemKind?: AkashaGatewayInboxEvent["itemKind"];
	sourceEventId?: string;
	now?: Date;
}

export interface AkashaGatewayInboxCounts {
	pending: number;
	deadLetters: number;
}

export class AkashaGatewayInboxStore {
	constructor(private readonly agentDir: string) {}

	enqueue(input: AkashaGatewayInboxEnqueueInput): { record: AkashaGatewayInboxEvent; enqueued: boolean } {
		const messageKey = input.messageKey ?? akashaGatewayMessageKey(input.message);
		const existing = this.project().get(messageKey);
		if (existing) return { record: existing, enqueued: false };
		const record: AkashaGatewayInboxEvent = {
			recordType: "gateway.inbox",
			messageKey,
			itemKind: input.itemKind,
			state: "queued",
			attempt: 0,
			eventTime: (input.now ?? new Date()).toISOString(),
			chat: input.chat,
			message: input.message,
			sourceEventId: input.sourceEventId,
		};
		this.append(record);
		return { record, enqueued: true };
	}

	markRunning(messageKey: string, now = new Date(), leaseMs = AKASHA_GATEWAY_INBOX_LEASE_MS): AkashaGatewayInboxEvent {
		const current = this.requireRecord(messageKey);
		const record = this.copyWith(current, {
			state: "running",
			attempt: current.attempt + 1,
			eventTime: now.toISOString(),
			leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
			error: undefined,
		});
		this.append(record);
		return record;
	}

	markSucceeded(messageKey: string, outboxIds: string[] = [], now = new Date()): AkashaGatewayInboxEvent {
		const current = this.requireRecord(messageKey);
		const record = this.copyWith(current, {
			state: "succeeded",
			eventTime: now.toISOString(),
			leaseExpiresAt: undefined,
			error: undefined,
			outboxIds,
		});
		this.append(record);
		return record;
	}

	markFailed(messageKey: string, error: string, now = new Date()): AkashaGatewayInboxEvent {
		const current = this.requireRecord(messageKey);
		const record = this.copyWith(current, {
			state: "failed",
			eventTime: now.toISOString(),
			leaseExpiresAt: undefined,
			error,
		});
		this.append(record);
		return record;
	}

	markDeadLetter(messageKey: string, error: string, now = new Date()): AkashaGatewayInboxEvent {
		const current = this.requireRecord(messageKey);
		const record = this.copyWith(current, {
			state: "dead_letter",
			eventTime: now.toISOString(),
			leaseExpiresAt: undefined,
			error,
		});
		this.append(record);
		return record;
	}

	listRunnable(now = new Date()): AkashaGatewayInboxEvent[] {
		const nowMs = now.getTime();
		return [...this.project().values()]
			.filter((record) => {
				if (record.attempt >= AKASHA_GATEWAY_INBOX_MAX_ATTEMPTS) return false;
				if (record.state === "queued" || record.state === "failed") return true;
				if (record.state !== "running" || !record.leaseExpiresAt) return false;
				return Date.parse(record.leaseExpiresAt) <= nowMs;
			})
			.sort(compareInboxRecords);
	}

	listDeadLetterCandidates(now = new Date()): AkashaGatewayInboxEvent[] {
		const nowMs = now.getTime();
		return [...this.project().values()]
			.filter((record) => {
				if (record.state === "dead_letter" || record.state === "succeeded") return false;
				if (record.attempt < AKASHA_GATEWAY_INBOX_MAX_ATTEMPTS) return false;
				if (record.state === "running")
					return record.leaseExpiresAt ? Date.parse(record.leaseExpiresAt) <= nowMs : true;
				return record.state === "failed";
			})
			.sort(compareInboxRecords);
	}

	project(): Map<string, AkashaGatewayInboxEvent> {
		const records = new Map<string, AkashaGatewayInboxEvent>();
		for (const record of this.readRecords()) {
			const current = records.get(record.messageKey);
			records.set(record.messageKey, current ? mergeInboxRecord(current, record) : record);
		}
		return records;
	}

	counts(now = new Date()): AkashaGatewayInboxCounts {
		const nowMs = now.getTime();
		let pending = 0;
		let deadLetters = 0;
		for (const record of this.project().values()) {
			if (record.state === "dead_letter") {
				deadLetters++;
				continue;
			}
			if (record.state === "succeeded") continue;
			if (record.attempt >= AKASHA_GATEWAY_INBOX_MAX_ATTEMPTS) {
				if (record.state !== "running" || !record.leaseExpiresAt || Date.parse(record.leaseExpiresAt) <= nowMs) {
					deadLetters++;
				}
				continue;
			}
			pending++;
		}
		return { pending, deadLetters };
	}

	private append(record: AkashaGatewayInboxEvent): void {
		mkdirSync(dirname(this.path), { recursive: true });
		appendFileSync(this.path, `${JSON.stringify(record)}\n`, "utf-8");
	}

	private readRecords(): AkashaGatewayInboxEvent[] {
		if (!existsSync(this.path)) return [];
		return readFileSync(this.path, "utf-8")
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.flatMap((line) => {
				try {
					const parsed = JSON.parse(line) as unknown;
					return isInboxRecord(parsed) ? [parsed] : [];
				} catch {
					return [];
				}
			});
	}

	private requireRecord(messageKey: string): AkashaGatewayInboxEvent {
		const record = this.project().get(messageKey);
		if (!record) throw new Error(`Gateway inbox record not found: ${messageKey}`);
		return record;
	}

	private copyWith(
		current: AkashaGatewayInboxEvent,
		update: Partial<AkashaGatewayInboxEvent> & Pick<AkashaGatewayInboxEvent, "state" | "eventTime">,
	): AkashaGatewayInboxEvent {
		return {
			recordType: "gateway.inbox",
			messageKey: current.messageKey,
			itemKind: update.itemKind ?? current.itemKind,
			state: update.state,
			attempt: update.attempt ?? current.attempt,
			eventTime: update.eventTime,
			leaseExpiresAt: update.leaseExpiresAt,
			message: update.message ?? current.message,
			chat: update.chat ?? current.chat,
			error: update.error,
			outboxIds: update.outboxIds ?? current.outboxIds,
			sourceEventId: update.sourceEventId ?? current.sourceEventId,
		};
	}

	private get path(): string {
		return resolveAkashaGatewayInboxPath(this.agentDir);
	}
}

export function resolveAkashaGatewayInboxPath(agentDir: string): string {
	return join(agentDir, "gateway", "inbox.jsonl");
}

export function akashaGatewayMessageKey(message: AkashaGatewayIncomingMessage): string {
	return `${message.platform}:${message.chatId}:${message.updateId ?? message.messageId}`;
}

function mergeInboxRecord(current: AkashaGatewayInboxEvent, next: AkashaGatewayInboxEvent): AkashaGatewayInboxEvent {
	return {
		...next,
		itemKind: next.itemKind ?? current.itemKind,
		message: next.message ?? current.message,
		chat: next.chat ?? current.chat,
		outboxIds: next.outboxIds ?? current.outboxIds,
		sourceEventId: next.sourceEventId ?? current.sourceEventId,
	};
}

function compareInboxRecords(a: AkashaGatewayInboxEvent, b: AkashaGatewayInboxEvent): number {
	return Date.parse(a.eventTime) - Date.parse(b.eventTime) || a.messageKey.localeCompare(b.messageKey);
}

function isInboxRecord(value: unknown): value is AkashaGatewayInboxEvent {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		record.recordType === "gateway.inbox" &&
		typeof record.messageKey === "string" &&
		isInboxState(record.state) &&
		typeof record.attempt === "number" &&
		typeof record.eventTime === "string"
	);
}

function isInboxState(value: unknown): value is AkashaGatewayInboxEvent["state"] {
	return (
		value === "queued" ||
		value === "running" ||
		value === "succeeded" ||
		value === "failed" ||
		value === "dead_letter"
	);
}
