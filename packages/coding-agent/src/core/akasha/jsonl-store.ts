import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { v7 as uuidv7 } from "uuid";
import { parseAkashaJsonl } from "./schema.js";
import { sanitizeAkashaEventDraft } from "./sensitive-data.js";
import type { AkashaEvent, AkashaEventDraft, AkashaQuery, AkashaStore } from "./types.js";

function matchesText(event: AkashaEvent, text: string): boolean {
	const needle = text.trim().toLowerCase();
	if (!needle) return true;
	return JSON.stringify(event).toLowerCase().includes(needle);
}

function inTimeRange(event: AkashaEvent, query: AkashaQuery): boolean {
	const eventTime = Date.parse(event.eventTime);
	if (query.since && eventTime < Date.parse(query.since)) return false;
	if (query.until && eventTime > Date.parse(query.until)) return false;
	return true;
}

export class JsonlAkashaStore implements AkashaStore {
	readonly eventLogPath: string;
	private events: AkashaEvent[] = [];
	private byId = new Map<string, AkashaEvent>();
	private bySourceKey = new Map<string, AkashaEvent>();
	private lastSequence = 0;
	private schemaIssues = 0;
	private redactSecrets: boolean;

	constructor(eventLogPath: string, options: { redactSecrets?: boolean } = {}) {
		this.eventLogPath = eventLogPath;
		this.redactSecrets = options.redactSecrets ?? true;
		mkdirSync(dirname(this.eventLogPath), { recursive: true });
		this.load();
	}

	private load(): void {
		if (!existsSync(this.eventLogPath)) return;

		const content = readFileSync(this.eventLogPath, "utf-8");
		const parsed = parseAkashaJsonl(content);
		this.schemaIssues = parsed.issues.length;
		for (const event of parsed.events) {
			this.events.push(event);
			this.indexEvent(event);
		}
	}

	private indexEvent(event: AkashaEvent): void {
		this.byId.set(event.eventId, event);
		if (event.sourceKey && !this.bySourceKey.has(event.sourceKey)) {
			this.bySourceKey.set(event.sourceKey, event);
		}
		this.lastSequence = Math.max(this.lastSequence, event.sequence);
	}

	append(draft: AkashaEventDraft): AkashaEvent {
		if (draft.sourceKey) {
			const existing = this.bySourceKey.get(draft.sourceKey);
			if (existing) return existing;
		}

		const safeDraft = this.redactSecrets ? sanitizeAkashaEventDraft(draft) : draft;
		const now = new Date().toISOString();
		const event: AkashaEvent = {
			...safeDraft,
			eventId: safeDraft.eventId ?? uuidv7(),
			sequence: safeDraft.sequence ?? this.lastSequence + 1,
			recordedTime: safeDraft.recordedTime ?? now,
			parentEventIds: safeDraft.parentEventIds ?? [],
			payload: safeDraft.payload ?? {},
			importance: safeDraft.importance ?? 0.5,
			ttlPolicy: safeDraft.ttlPolicy ?? "session",
			version: 1,
		};

		this.events.push(event);
		this.indexEvent(event);
		appendFileSync(this.eventLogPath, `${JSON.stringify(event)}\n`, "utf-8");
		return event;
	}

	listRecent(query: AkashaQuery = {}): AkashaEvent[] {
		const limit = query.limit ?? 50;
		const kinds = query.kinds ? new Set(query.kinds) : undefined;
		return this.events
			.filter((event) => !kinds || kinds.has(event.kind))
			.filter((event) => !query.toolCallId || event.toolCallId === query.toolCallId)
			.filter((event) => !query.text || matchesText(event, query.text))
			.filter((event) => inTimeRange(event, query))
			.sort((a, b) => b.sequence - a.sequence)
			.slice(0, limit);
	}

	findById(eventId: string): AkashaEvent | undefined {
		return this.byId.get(eventId);
	}

	findByToolCallId(toolCallId: string): AkashaEvent | undefined {
		const matches = [...this.events].reverse().filter((event) => event.toolCallId === toolCallId);
		return (
			matches.find(
				(event) =>
					event.kind === "artifact.read" ||
					event.kind === "artifact.written" ||
					event.kind === "artifact.patched" ||
					event.kind === "command.executed",
			) ??
			matches.find((event) => event.kind === "message.tool_result.recorded") ??
			matches.find((event) => event.kind === "tool.completed") ??
			matches.find((event) => event.kind === "tool.blocked") ??
			matches.find((event) => event.kind === "tool.requested")
		);
	}

	explainChain(eventIdOrToolCallId: string): AkashaEvent[] {
		const target = this.findById(eventIdOrToolCallId) ?? this.findByToolCallId(eventIdOrToolCallId);
		if (!target) return [];

		const chain: AkashaEvent[] = [];
		const seen = new Set<string>();
		const visit = (event: AkashaEvent): void => {
			if (seen.has(event.eventId)) return;
			seen.add(event.eventId);
			for (const parentId of event.parentEventIds) {
				const parent = this.byId.get(parentId);
				if (parent) visit(parent);
			}
			chain.push(event);
		};
		visit(target);
		return chain;
	}

	buildTimeline(query: AkashaQuery = {}): AkashaEvent[] {
		return this.listRecent(query).sort((a, b) => a.sequence - b.sequence);
	}

	getSchemaIssueCount(): number {
		return this.schemaIssues;
	}
}
