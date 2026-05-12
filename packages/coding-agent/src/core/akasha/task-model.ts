import { buildArtifactStates } from "./artifact-state.js";
import { buildKarmaLedger } from "./karma-ledger.js";
import { buildOpenLoopLedger } from "./open-loops.js";
import { orderAkashaEvents } from "./ordering.js";
import type { AkashaEvent } from "./types.js";

export interface AkashaGoalState {
	goalId: string;
	text: string;
	status: "active" | "superseded";
	eventId: string;
	eventTime: string;
}

export interface AkashaTaskState {
	taskId: string;
	text: string;
	status: "open" | "overdue" | "resolved" | "blocked";
	eventId: string;
	eventTime: string;
	dueTime?: string;
}

export interface AkashaDecisionState {
	decisionId: string;
	text: string;
	eventId: string;
	eventTime: string;
	kind: AkashaEvent["kind"];
}

export interface AkashaRiskState {
	riskId: string;
	reason: string;
	severity: "medium" | "high" | "critical";
	text: string;
	eventId: string;
	eventTime: string;
	objectId?: string;
}

export interface AkashaTaskModel {
	goals: AkashaGoalState[];
	tasks: AkashaTaskState[];
	decisions: AkashaDecisionState[];
	risks: AkashaRiskState[];
	lastEventId?: string;
	lastEventTime?: string;
}

export function buildAkashaTaskModel(events: AkashaEvent[]): AkashaTaskModel {
	const ordered = orderAkashaEvents(events);
	const goals = extractGoals(ordered);
	const ledger = buildKarmaLedger(ordered);
	const loops = buildOpenLoopLedger(ordered);
	const artifacts = buildArtifactStates(ordered);
	const lastEvent = ordered.at(-1);

	return {
		goals,
		tasks: [
			...ledger.promises.map((promise) => ({
				taskId: promise.promiseId,
				text: promise.summary,
				status: promise.state,
				eventId: promise.lastEventId,
				eventTime: promise.lastEventTime,
				dueTime: promise.dueTime,
			})),
			...loops
				.filter((loop) => loop.state !== "resolved")
				.map((loop) => ({
					taskId: loop.loopKey,
					text: loop.summary,
					status: loop.state === "blocked" ? ("blocked" as const) : ("open" as const),
					eventId: loop.openedEventId ?? loop.rootEventId,
					eventTime: eventTime(ordered, loop.openedEventId ?? loop.rootEventId),
				})),
		],
		decisions: extractDecisions(ordered),
		risks: [
			...ordered.flatMap(toolBlockedRisk),
			...artifacts
				.filter((artifact) => artifact.status === "modified_unverified" || artifact.status === "failed")
				.map((artifact) => ({
					riskId: `artifact:${artifact.path}:${artifact.status}`,
					reason: artifact.status,
					severity: artifact.status === "failed" ? ("high" as const) : ("medium" as const),
					text:
						artifact.status === "failed"
							? `${artifact.path} has a failed artifact operation`
							: `${artifact.path} was modified without later validation`,
					eventId: artifact.lastEventId,
					eventTime: artifact.lastEventTime,
					objectId: artifact.path,
				})),
		],
		lastEventId: lastEvent?.eventId,
		lastEventTime: lastEvent?.eventTime,
	};
}

function extractGoals(events: AkashaEvent[]): AkashaGoalState[] {
	const goalEvents = events.filter(
		(event) => event.kind === "message.user.submitted" && looksLikeGoal(eventText(event)),
	);
	return goalEvents
		.map((event, index) => ({
			goalId: event.eventId,
			text: eventText(event),
			status: index === goalEvents.length - 1 ? ("active" as const) : ("superseded" as const),
			eventId: event.eventId,
			eventTime: event.eventTime,
		}))
		.reverse();
}

function extractDecisions(events: AkashaEvent[]): AkashaDecisionState[] {
	return events
		.filter(isDecisionEvent)
		.map((event) => ({
			decisionId: event.eventId,
			text: eventText(event),
			eventId: event.eventId,
			eventTime: event.eventTime,
			kind: event.kind,
		}))
		.slice(-12)
		.reverse();
}

function toolBlockedRisk(event: AkashaEvent): AkashaRiskState[] {
	if (event.kind !== "tool.blocked") return [];
	const severity = event.payload.rule === "destructive_command" ? "critical" : "high";
	return [
		{
			riskId: `blocked:${event.eventId}`,
			reason: typeof event.payload.rule === "string" ? event.payload.rule : "tool_blocked",
			severity,
			text: typeof event.payload.reason === "string" ? event.payload.reason : "Tool call blocked by Akasha",
			eventId: event.eventId,
			eventTime: event.eventTime,
			objectId: event.objectId,
		},
	];
}

function eventTime(events: AkashaEvent[], eventId: string): string {
	return events.find((event) => event.eventId === eventId)?.eventTime ?? new Date(0).toISOString();
}

function looksLikeGoal(text: string): boolean {
	const lower = text.toLowerCase();
	return (
		lower.includes("goal") ||
		lower.includes("plan") ||
		lower.includes("implement") ||
		lower.includes("build") ||
		text.includes("目标") ||
		text.includes("计划") ||
		text.includes("实现") ||
		text.includes("开发")
	);
}

function isDecisionEvent(event: AkashaEvent): boolean {
	if (
		event.kind === "message.agent.completed" ||
		event.kind === "branch.summary_created" ||
		event.kind === "failure.lesson_learned" ||
		event.kind === "workflow.optimized" ||
		event.kind === "policy.evaluated"
	) {
		return eventText(event).length > 0;
	}
	return false;
}

function eventText(event: AkashaEvent): string {
	const payload = event.payload;
	if (typeof payload.text === "string") return payload.text;
	if (typeof payload.summary === "string") return payload.summary;
	if (typeof payload.reason === "string") return payload.reason;
	if (typeof payload.lesson === "string") return payload.lesson;
	return "";
}
