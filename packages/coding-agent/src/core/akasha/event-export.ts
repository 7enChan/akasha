import { applyAkashaRedactions } from "./redaction.js";
import type { AkashaEvent } from "./types.js";

export type AkashaExportFormat = "json" | "jsonl";

export interface AkashaExportOptions {
	format?: AkashaExportFormat;
	applyRedactions?: boolean;
	includeRedactionEvents?: boolean;
}

export function exportAkashaEvents(events: AkashaEvent[], options: AkashaExportOptions = {}): string {
	const format = options.format ?? "jsonl";
	const redacted = options.applyRedactions === false ? events : applyAkashaRedactions(events);
	const exported =
		options.includeRedactionEvents === false ? redacted.filter((event) => event.kind !== "event.redacted") : redacted;
	const ordered = [...exported].sort((a, b) => a.eventTime.localeCompare(b.eventTime) || a.sequence - b.sequence);
	if (format === "json") return `${JSON.stringify(ordered, null, 2)}\n`;
	return ordered.map((event) => JSON.stringify(event)).join("\n") + (ordered.length > 0 ? "\n" : "");
}

export function importAkashaEvents(content: string): AkashaEvent[] {
	const trimmed = content.trim();
	if (!trimmed) return [];
	if (trimmed.startsWith("[")) {
		const parsed = JSON.parse(trimmed) as unknown;
		return Array.isArray(parsed) ? parsed.filter(isAkashaEvent) : [];
	}
	return trimmed
		.split(/\r?\n/)
		.map((line) => JSON.parse(line) as unknown)
		.filter(isAkashaEvent);
}

function isAkashaEvent(value: unknown): value is AkashaEvent {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.eventId === "string" &&
		typeof record.kind === "string" &&
		typeof record.sessionId === "string" &&
		typeof record.streamId === "string" &&
		typeof record.sequence === "number" &&
		typeof record.eventTime === "string" &&
		typeof record.recordedTime === "string" &&
		Array.isArray(record.parentEventIds) &&
		typeof record.payload === "object" &&
		record.payload !== null
	);
}
