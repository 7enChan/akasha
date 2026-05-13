import { createHash } from "node:crypto";
import { projectAkashaGovernedEvents } from "./governance-projection.js";
import type { AkashaProjectTimeline } from "./project-timeline.js";
import type { AkashaEvent } from "./types.js";
import type { AkashaUserTimeline } from "./user-timeline.js";
import { buildProjectState } from "./world-model.js";

export interface AkashaMemoryCue {
	cueId: string;
	createdAt: string;
	userText?: string;
	cwd?: string;
	activeFiles: string[];
	activeTaskIds: string[];
	activeCallbackIds: string[];
	pendingInboxItemIds: string[];
	currentGoal?: string;
	recentFailureEventIds: string[];
	policyPressure: string[];
	userPreferenceEventIds: string[];
	strictRepairMissingEventIds: string[];
	sourceEventIds: string[];
}

export interface AkashaMemoryCueOptions {
	latestUserText?: string;
	cwd?: string;
	sessionEvents: AkashaEvent[];
	projectTimeline?: AkashaProjectTimeline;
	userTimeline?: AkashaUserTimeline;
	pendingInboxItemIds?: string[];
	strictRepairMissingEventIds?: string[];
	now?: string;
}

export function buildAkashaMemoryCue(options: AkashaMemoryCueOptions): AkashaMemoryCue {
	const createdAt = options.now ?? new Date().toISOString();
	const sessionEvents = projectAkashaGovernedEvents(options.sessionEvents).events;
	const projectEvents = projectAkashaGovernedEvents(options.projectTimeline?.events ?? sessionEvents).events;
	const projectState = buildProjectState(projectEvents);
	const recentFailures = projectEvents.filter(isFailureEvent).slice(-8);
	const policyEvents = projectEvents.filter(isPolicyPressureEvent).slice(-8);
	const activeCallbackIds = uniqueStrings([
		...projectEvents
			.slice(-60)
			.map((event) => stringPayload(event, "callbackId"))
			.filter((id): id is string => typeof id === "string"),
	]);
	const userPreferenceEventIds = [
		...(options.userTimeline?.preferences ?? []),
		...(options.userTimeline?.collaborationHints ?? []),
	]
		.slice(0, 12)
		.map((fact) => fact.eventId);
	const sourceEventIds = uniqueStrings([
		projectState.currentGoalEventId,
		...projectState.activeFiles.map((file) => file.lastEventId),
		...recentFailures.map((event) => event.eventId),
		...policyEvents.map((event) => event.eventId),
		...userPreferenceEventIds,
		...(options.strictRepairMissingEventIds ?? []),
	]);
	const cue: Omit<AkashaMemoryCue, "cueId"> = {
		createdAt,
		userText: options.latestUserText,
		cwd: options.cwd,
		activeFiles: projectState.activeFiles.map((file) => file.path),
		activeTaskIds: projectState.blockers.map((blocker) => blocker.rootEventId),
		activeCallbackIds,
		pendingInboxItemIds: options.pendingInboxItemIds ?? [],
		currentGoal: projectState.currentGoal,
		recentFailureEventIds: recentFailures.map((event) => event.eventId),
		policyPressure: uniqueStrings(policyEvents.map(policyPressureKey)),
		userPreferenceEventIds,
		strictRepairMissingEventIds: options.strictRepairMissingEventIds ?? [],
		sourceEventIds,
	};
	return {
		...cue,
		cueId: `cue_${hashJson(cue).slice(0, 24)}`,
	};
}

function isFailureEvent(event: AkashaEvent): boolean {
	return (
		event.kind === "tool.blocked" ||
		event.kind === "loop.blocked" ||
		event.kind === "prediction.corrected" ||
		event.kind === "time.callback.failed" ||
		event.kind === "gateway.delivery.failed" ||
		event.kind === "failure.lesson_learned" ||
		(event.kind === "tool.completed" && event.payload.isError === true) ||
		(event.kind === "command.executed" && typeof event.payload.exitCode === "number" && event.payload.exitCode !== 0)
	);
}

function isPolicyPressureEvent(event: AkashaEvent): boolean {
	if (event.kind === "tool.blocked") return true;
	if (event.kind !== "policy.evaluated") return false;
	const action = event.payload.action ?? event.payload.decision;
	return typeof action === "string" && action !== "allow";
}

function policyPressureKey(event: AkashaEvent): string {
	return (
		stringPayload(event, "ruleId") ??
		stringPayload(event, "actionType") ??
		stringPayload(event, "decision") ??
		event.kind
	);
}

function stringPayload(event: AkashaEvent, key: string): string | undefined {
	const value = event.payload[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
	return [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0))];
}

function hashJson(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
