import { projectAkashaGovernedEvents } from "./governance-projection.js";
import { JsonlAkashaStore } from "./jsonl-store.js";
import { orderAkashaEvents } from "./ordering.js";
import { buildAkashaSessionIndex } from "./session-index.js";
import type { AkashaEvent } from "./types.js";
import { type AkashaProjectState, buildProjectState } from "./world-model.js";

export interface AkashaProjectTimelineOptions {
	agentDir: string;
	eventLogDir?: string;
	cwd: string;
	limit?: number;
}

export interface AkashaProjectTimelineSession {
	sessionId: string;
	eventLogPath: string;
	eventCount: number;
	startedAt?: string;
	lastEventTime?: string;
}

export interface AkashaProjectTimeline {
	cwd: string;
	sessions: AkashaProjectTimelineSession[];
	events: AkashaEvent[];
	state: AkashaProjectState;
	lastEventId?: string;
	lastEventTime?: string;
}

export function buildAkashaProjectTimeline(options: AkashaProjectTimelineOptions): AkashaProjectTimeline {
	const sessions = buildAkashaSessionIndex({
		agentDir: options.agentDir,
		eventLogDir: options.eventLogDir,
		cwd: options.cwd,
	});
	const events = orderAkashaEvents(
		sessions.flatMap((session) =>
			new JsonlAkashaStore(session.eventLogPath).buildTimeline({ limit: Number.MAX_SAFE_INTEGER }),
		),
	);
	const governedEvents = projectAkashaGovernedEvents(events).events;
	const limited =
		typeof options.limit === "number" && options.limit > 0 ? governedEvents.slice(-options.limit) : governedEvents;
	const lastEvent = governedEvents.at(-1);

	return {
		cwd: options.cwd,
		sessions: sessions.map((session) => ({
			sessionId: session.sessionId,
			eventLogPath: session.eventLogPath,
			eventCount: session.eventCount,
			startedAt: session.startedAt,
			lastEventTime: session.lastEventTime,
		})),
		events: limited,
		state: buildProjectState(governedEvents),
		lastEventId: lastEvent?.eventId,
		lastEventTime: lastEvent?.eventTime,
	};
}

export function summarizeProjectTimeline(timeline: AkashaProjectTimeline): string {
	const lines = [
		`Project timeline: ${timeline.sessions.length} sessions, ${timeline.events.length} shown events`,
		`cwd: ${timeline.cwd}`,
	];
	if (timeline.lastEventTime) lines.push(`last event: ${timeline.lastEventTime}`);
	lines.push("");
	lines.push("Current goal:");
	lines.push(timeline.state.currentGoal || "(none)");
	lines.push("");
	lines.push("Active files:");
	if (timeline.state.activeFiles.length === 0) {
		lines.push("- (none)");
	} else {
		for (const file of timeline.state.activeFiles.slice(0, 8)) {
			lines.push(`- ${file.path} (${file.status})`);
		}
	}
	lines.push("");
	lines.push("Open blockers:");
	if (timeline.state.blockers.length === 0) {
		lines.push("- (none)");
	} else {
		for (const blocker of timeline.state.blockers.slice(0, 8)) {
			const target = blocker.objectId ? ` ${blocker.objectId}` : "";
			lines.push(`- ${blocker.reason}${target}: ${blocker.summary}`);
		}
	}
	return lines.join("\n");
}
