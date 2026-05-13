import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AkashaRunnableCallback } from "./callback-runner.js";
import type { AkashaEvent, AkashaEventKind, AkashaStore } from "./types.js";

export type AkashaCallbackInboxPromptStatus = "pending" | "injected" | "consumed" | "failed" | "cancelled";

export interface AkashaPendingCallbackPrompt {
	recordType?: "prompt";
	id: string;
	callbackId: string;
	sessionId: string;
	streamId: string;
	eventTime: string;
	summary: string;
	kind?: string;
	targetEventId?: string;
	dueEventId: string;
	claimEventId: string;
	prompt: string;
	status: "pending";
}

export interface AkashaCallbackInboxStatusRecord {
	recordType: "status";
	id: string;
	promptId: string;
	callbackId: string;
	sessionId?: string;
	streamId?: string;
	eventTime: string;
	status: Exclude<AkashaCallbackInboxPromptStatus, "pending">;
	eventId?: string;
	consumerSessionId?: string;
	reason?: string;
}

export interface AkashaCallbackInboxItem {
	prompt: AkashaPendingCallbackPrompt;
	status: AkashaCallbackInboxPromptStatus;
	statusRecords: AkashaCallbackInboxStatusRecord[];
	lastStatusRecord?: AkashaCallbackInboxStatusRecord;
}

export interface AkashaCallbackInboxStatusOptions {
	status: Exclude<AkashaCallbackInboxPromptStatus, "pending">;
	eventTime?: string;
	eventId?: string;
	consumerSessionId?: string;
	reason?: string;
}

export function resolveAkashaCallbackInboxPath(agentDir: string): string {
	return join(agentDir, "akasha", "inbox", "pending-callbacks.jsonl");
}

export function appendAkashaPendingCallbackPrompt(
	agentDir: string,
	callback: AkashaRunnableCallback,
	claim: AkashaEvent,
	now: Date,
): AkashaPendingCallbackPrompt {
	const prompt: AkashaPendingCallbackPrompt = {
		recordType: "prompt",
		id: `pending:${callback.callbackId}:${claim.eventId}`,
		callbackId: callback.callbackId,
		sessionId: claim.sessionId,
		streamId: claim.streamId,
		eventTime: now.toISOString(),
		summary: callback.summary,
		kind: callback.kind,
		targetEventId: callback.targetEventId,
		dueEventId: callback.dueEvent.eventId,
		claimEventId: claim.eventId,
		prompt: formatPendingCallbackPrompt(callback),
		status: "pending",
	};
	const path = resolveAkashaCallbackInboxPath(agentDir);
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${JSON.stringify(prompt)}\n`, "utf-8");
	return prompt;
}

export function appendAkashaCallbackInboxStatus(
	agentDir: string,
	prompt: AkashaPendingCallbackPrompt,
	options: AkashaCallbackInboxStatusOptions,
): AkashaCallbackInboxStatusRecord {
	const eventTime = options.eventTime ?? new Date().toISOString();
	const record: AkashaCallbackInboxStatusRecord = {
		recordType: "status",
		id: `status:${prompt.id}:${options.status}:${eventTime}`,
		promptId: prompt.id,
		callbackId: prompt.callbackId,
		sessionId: prompt.sessionId,
		streamId: prompt.streamId,
		eventTime,
		status: options.status,
		eventId: options.eventId,
		consumerSessionId: options.consumerSessionId,
		reason: options.reason,
	};
	const path = resolveAkashaCallbackInboxPath(agentDir);
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${JSON.stringify(record)}\n`, "utf-8");
	return record;
}

export function listAkashaPendingCallbackPrompts(agentDir: string): AkashaPendingCallbackPrompt[] {
	return projectAkashaCallbackInbox(agentDir)
		.filter((item) => item.status === "pending")
		.map((item) => item.prompt);
}

export function listAkashaActionableCallbackPrompts(agentDir: string): AkashaCallbackInboxItem[] {
	return projectAkashaCallbackInbox(agentDir).filter(
		(item) => item.status === "pending" || item.status === "injected",
	);
}

export function projectAkashaCallbackInbox(agentDir: string): AkashaCallbackInboxItem[] {
	const prompts = new Map<string, AkashaPendingCallbackPrompt>();
	const statuses = new Map<string, AkashaCallbackInboxStatusRecord[]>();
	for (const record of readAkashaCallbackInboxRecords(agentDir)) {
		if (isPendingPrompt(record)) {
			prompts.set(record.id, record);
			continue;
		}
		if (isInboxStatusRecord(record)) {
			const list = statuses.get(record.promptId) ?? [];
			list.push(record);
			statuses.set(record.promptId, list);
		}
	}
	return [...prompts.values()]
		.map((prompt) => {
			const statusRecords = (statuses.get(prompt.id) ?? []).sort((a, b) => a.eventTime.localeCompare(b.eventTime));
			const lastStatusRecord = statusRecords.at(-1);
			const status: AkashaCallbackInboxPromptStatus = lastStatusRecord?.status ?? "pending";
			return {
				prompt,
				status,
				statusRecords,
				lastStatusRecord,
			};
		})
		.sort((a, b) => a.prompt.eventTime.localeCompare(b.prompt.eventTime));
}

export function appendAkashaCallbackInboxEvent(
	store: AkashaStore,
	kind: Extract<
		AkashaEventKind,
		| "callback.inbox.added"
		| "callback.inbox.injected"
		| "callback.inbox.consumed"
		| "callback.inbox.failed"
		| "callback.inbox.cancelled"
	>,
	prompt: AkashaPendingCallbackPrompt,
	options: {
		eventTime?: string;
		parentEventIds?: string[];
		sessionId?: string;
		streamId?: string;
		consumerSessionId?: string;
		reason?: string;
		sourceKeySuffix?: string;
	} = {},
): AkashaEvent {
	const eventTime = options.eventTime ?? new Date().toISOString();
	const status = kind.slice("callback.inbox.".length);
	return store.append({
		kind,
		sessionId: options.sessionId ?? prompt.sessionId,
		streamId: options.streamId ?? prompt.streamId,
		eventTime,
		actor: "system",
		subjectId: "akasha.callback_inbox",
		objectId: prompt.id,
		sourceKey: `callback-inbox:${status}:${prompt.id}${options.sourceKeySuffix ? `:${options.sourceKeySuffix}` : ""}`,
		parentEventIds: options.parentEventIds ?? [prompt.claimEventId, prompt.dueEventId],
		payload: {
			inboxItemId: prompt.id,
			callbackId: prompt.callbackId,
			dueEventId: prompt.dueEventId,
			claimEventId: prompt.claimEventId,
			targetEventId: prompt.targetEventId,
			summary: prompt.summary,
			status,
			consumerSessionId: options.consumerSessionId,
			reason: options.reason,
		},
		importance: kind === "callback.inbox.added" ? 0.75 : 0.8,
		ttlPolicy: "long_term",
	});
}

function readAkashaCallbackInboxRecords(agentDir: string): unknown[] {
	const path = resolveAkashaCallbackInboxPath(agentDir);
	try {
		return readFileSync(path, "utf-8")
			.split(/\r?\n/)
			.filter((line) => line.trim().length > 0)
			.flatMap((line) => {
				try {
					return [JSON.parse(line) as unknown];
				} catch {
					return [];
				}
			});
	} catch {
		return [];
	}
}

function formatPendingCallbackPrompt(callback: AkashaRunnableCallback): string {
	const target = callback.targetEventId ? `\nTarget event: ${callback.targetEventId}` : "";
	return [
		"Akasha callback is due. Continue this temporal responsibility:",
		"",
		callback.summary,
		target,
		"",
		"Review the callback's causal chain before acting, then either complete, cancel, or update it.",
	].join("\n");
}

function isPendingPrompt(value: unknown): value is AkashaPendingCallbackPrompt {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		(record.recordType === undefined || record.recordType === "prompt") &&
		typeof record.id === "string" &&
		typeof record.callbackId === "string" &&
		typeof record.sessionId === "string" &&
		typeof record.streamId === "string" &&
		typeof record.eventTime === "string" &&
		typeof record.summary === "string" &&
		typeof record.dueEventId === "string" &&
		typeof record.claimEventId === "string" &&
		typeof record.prompt === "string" &&
		record.status === "pending"
	);
}

function isInboxStatusRecord(value: unknown): value is AkashaCallbackInboxStatusRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		record.recordType === "status" &&
		typeof record.id === "string" &&
		typeof record.promptId === "string" &&
		typeof record.callbackId === "string" &&
		typeof record.eventTime === "string" &&
		(record.status === "injected" ||
			record.status === "consumed" ||
			record.status === "failed" ||
			record.status === "cancelled")
	);
}
