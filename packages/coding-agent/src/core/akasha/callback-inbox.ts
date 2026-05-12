import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AkashaRunnableCallback } from "./callback-runner.js";
import type { AkashaEvent } from "./types.js";

export interface AkashaPendingCallbackPrompt {
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

export function listAkashaPendingCallbackPrompts(agentDir: string): AkashaPendingCallbackPrompt[] {
	const path = resolveAkashaCallbackInboxPath(agentDir);
	try {
		return readFileSync(path, "utf-8")
			.split(/\r?\n/)
			.filter((line) => line.trim().length > 0)
			.flatMap((line) => {
				try {
					const parsed = JSON.parse(line) as unknown;
					return isPendingPrompt(parsed) ? [parsed] : [];
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
