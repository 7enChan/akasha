import type { AkashaArtifactState } from "./artifact-state.js";
import { buildArtifactStates } from "./artifact-state.js";
import type { AkashaOpenLoopRecord } from "./open-loops.js";
import { buildOpenLoopLedger } from "./open-loops.js";
import { orderAkashaEvents } from "./ordering.js";
import type { AkashaTemporalState } from "./temporal-state.js";
import { buildTemporalState } from "./temporal-state.js";
import type { AkashaEvent } from "./types.js";

export interface AkashaProjectDecision {
	eventId: string;
	text: string;
	eventTime: string;
	kind: AkashaEvent["kind"];
}

export interface AkashaProjectBlocker {
	rootEventId: string;
	reason: string;
	summary: string;
	objectId?: string;
	toolCallId?: string;
}

export interface AkashaProjectState {
	currentGoal?: string;
	currentGoalEventId?: string;
	activeFiles: AkashaArtifactState[];
	blockers: AkashaProjectBlocker[];
	recentDecisions: AkashaProjectDecision[];
	lastCompactionEventId?: string;
	lastBranchSummaryEventId?: string;
}

export interface AkashaWorldModel {
	temporalState: AkashaTemporalState;
	artifactStates: AkashaArtifactState[];
	openLoops: AkashaOpenLoopRecord[];
	projectState: AkashaProjectState;
	lastEventId?: string;
	lastEventTime?: string;
}

export function buildWorldModel(events: AkashaEvent[]): AkashaWorldModel {
	const ordered = orderAkashaEvents(events);
	const temporalState = buildTemporalState(ordered);
	const artifactStates = buildArtifactStates(ordered);
	const openLoops = buildOpenLoopLedger(ordered);
	const lastEvent = ordered.at(-1);

	return {
		temporalState,
		artifactStates,
		openLoops,
		projectState: buildProjectStateFromParts(ordered, temporalState, artifactStates, openLoops),
		lastEventId: lastEvent?.eventId,
		lastEventTime: lastEvent?.eventTime,
	};
}

export function buildProjectState(events: AkashaEvent[]): AkashaProjectState {
	const ordered = orderAkashaEvents(events);
	return buildProjectStateFromParts(
		ordered,
		buildTemporalState(ordered),
		buildArtifactStates(ordered),
		buildOpenLoopLedger(ordered),
	);
}

function buildProjectStateFromParts(
	ordered: AkashaEvent[],
	temporalState: AkashaTemporalState,
	artifactStates: AkashaArtifactState[],
	openLoops: AkashaOpenLoopRecord[],
): AkashaProjectState {
	return {
		currentGoal: temporalState.currentIntent?.text,
		currentGoalEventId: temporalState.currentIntent?.eventId,
		activeFiles: artifactStates.filter((state) => state.status !== "observed").slice(0, 12),
		blockers: openLoops
			.filter((loop) => loop.state !== "resolved")
			.map((loop) => ({
				rootEventId: loop.rootEventId,
				reason: loop.reason,
				summary: loop.summary,
				objectId: loop.objectId,
				toolCallId: loop.toolCallId,
			})),
		recentDecisions: extractRecentDecisions(ordered),
		lastCompactionEventId: temporalState.lastCompactionEventId,
		lastBranchSummaryEventId: temporalState.lastBranchSummaryEventId,
	};
}

function extractRecentDecisions(events: AkashaEvent[]): AkashaProjectDecision[] {
	const decisions: AkashaProjectDecision[] = [];
	for (const event of events) {
		if (!isDecisionEvent(event)) continue;
		const text = eventText(event);
		if (!text) continue;
		decisions.push({
			eventId: event.eventId,
			text,
			eventTime: event.eventTime,
			kind: event.kind,
		});
	}
	return decisions.slice(-8).reverse();
}

function isDecisionEvent(event: AkashaEvent): boolean {
	if (
		event.kind === "preference.inferred" ||
		event.kind === "failure.lesson_learned" ||
		event.kind === "workflow.optimized" ||
		event.kind === "branch.summary_created"
	) {
		return true;
	}
	if (event.kind !== "message.agent.completed") return false;
	const text = eventText(event).toLowerCase();
	return (
		text.includes("i will") ||
		text.includes("i'll") ||
		text.includes("decided") ||
		text.includes("next") ||
		text.includes("我会") ||
		text.includes("决定") ||
		text.includes("接下来")
	);
}

function eventText(event: AkashaEvent): string {
	const payload = event.payload;
	if (typeof payload.summary === "string") return payload.summary;
	if (typeof payload.text === "string") return payload.text;
	if (typeof payload.lesson === "string") return payload.lesson;
	if (typeof payload.preference === "string") return payload.preference;
	return "";
}
