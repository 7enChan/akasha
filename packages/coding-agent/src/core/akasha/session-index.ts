import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { JsonlAkashaStore } from "./jsonl-store.js";
import { orderAkashaEvents } from "./ordering.js";
import type { AkashaEvent } from "./types.js";

export interface AkashaSessionIndexOptions {
	agentDir: string;
	eventLogDir?: string;
	cwd?: string;
}

export interface AkashaSessionIndexEntry {
	sessionId: string;
	eventLogPath: string;
	eventCount: number;
	cwd?: string;
	startedAt?: string;
	lastEventId?: string;
	lastEventTime?: string;
}

export function resolveAkashaEventsDir(agentDir: string, eventLogDir?: string): string {
	if (!eventLogDir) return join(agentDir, "akasha", "events");
	return isAbsolute(eventLogDir) ? eventLogDir : resolve(agentDir, eventLogDir);
}

export function listAkashaEventLogPaths(options: AkashaSessionIndexOptions): string[] {
	const dir = resolveAkashaEventsDir(options.agentDir, options.eventLogDir);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".jsonl"))
		.sort()
		.map((name) => join(dir, name));
}

export function buildAkashaSessionIndex(options: AkashaSessionIndexOptions): AkashaSessionIndexEntry[] {
	return listAkashaEventLogPaths(options)
		.map((eventLogPath) => indexSessionLog(eventLogPath))
		.filter((entry): entry is AkashaSessionIndexEntry => !!entry)
		.filter((entry) => !options.cwd || entry.cwd === options.cwd)
		.sort((a, b) => (b.lastEventTime ?? "").localeCompare(a.lastEventTime ?? ""));
}

export function loadAkashaProjectTimeline(options: AkashaSessionIndexOptions): AkashaEvent[] {
	return orderAkashaEvents(
		buildAkashaSessionIndex(options).flatMap((entry) =>
			new JsonlAkashaStore(entry.eventLogPath).buildTimeline({ limit: Number.MAX_SAFE_INTEGER }),
		),
	);
}

function indexSessionLog(eventLogPath: string): AkashaSessionIndexEntry | undefined {
	const store = new JsonlAkashaStore(eventLogPath);
	const events = store.buildTimeline({ limit: Number.MAX_SAFE_INTEGER });
	if (events.length === 0) return undefined;
	const sessionEvent =
		events.find(
			(event) =>
				event.kind === "session.started" ||
				event.kind === "session.resumed" ||
				event.kind === "session.forked" ||
				event.kind === "session.reloaded",
		) ?? events[0];
	const lastEvent = events.at(-1);
	return {
		sessionId: sessionEvent.sessionId,
		eventLogPath,
		eventCount: events.length,
		cwd: typeof sessionEvent.payload.cwd === "string" ? sessionEvent.payload.cwd : undefined,
		startedAt: sessionEvent.eventTime,
		lastEventId: lastEvent?.eventId,
		lastEventTime: lastEvent?.eventTime,
	};
}
