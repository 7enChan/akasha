import { projectAkashaGovernedEvents } from "./governance-projection.js";
import { buildKarmaLedger } from "./karma-ledger.js";
import { buildOpenLoopLedger } from "./open-loops.js";
import type { AkashaProjectTimeline } from "./project-timeline.js";
import type { AkashaEvent } from "./types.js";
import type { AkashaUserTimeline } from "./user-timeline.js";
import { buildProjectState } from "./world-model.js";

export interface AkashaActionGateOptions {
	sessionEvents: AkashaEvent[];
	projectTimeline?: AkashaProjectTimeline;
	userTimeline?: AkashaUserTimeline;
	maxItems?: number;
}

export interface AkashaActionGateContext {
	text: string;
	eventIds: string[];
	sections: string[];
	tokenEstimate: number;
}

export function buildAkashaActionGateContext(options: AkashaActionGateOptions): AkashaActionGateContext | undefined {
	const maxItems = Math.max(1, Math.floor(options.maxItems ?? 8));
	const sessionEvents = projectAkashaGovernedEvents(options.sessionEvents).events;
	const projectEvents = projectAkashaGovernedEvents(options.projectTimeline?.events ?? sessionEvents).events;
	const userEvents = projectAkashaGovernedEvents(options.userTimeline?.events ?? sessionEvents).events;
	const projectState = buildProjectState(projectEvents);
	const loops = buildOpenLoopLedger(projectEvents).filter((loop) => loop.state !== "resolved");
	const karma = buildKarmaLedger(userEvents);
	const preferences = options.userTimeline?.preferences.slice(0, maxItems) ?? [];
	const collaborationHints = options.userTimeline?.collaborationHints.slice(0, maxItems) ?? [];
	const corrections = options.userTimeline?.corrections.slice(0, maxItems) ?? [];
	const eventIds = new Set<string>();
	const sections = new Set<string>();

	const lines = ["<akasha_action_gate>", "Temporal control facts to consider before acting:"];
	let hasFacts = false;
	if (projectState.currentGoal) {
		hasFacts = true;
		sections.add("project_state");
		lines.push(`- Current project goal: ${projectState.currentGoal}`);
		if (projectState.currentGoalEventId) eventIds.add(projectState.currentGoalEventId);
	}

	if (projectState.activeFiles.length > 0) {
		hasFacts = true;
		sections.add("active_artifacts");
		lines.push(
			`- Active artifacts: ${projectState.activeFiles
				.slice(0, maxItems)
				.map((file) => `${file.path} (${file.status})`)
				.join(", ")}`,
		);
		for (const file of projectState.activeFiles.slice(0, maxItems)) eventIds.add(file.lastEventId);
	}

	if (loops.length > 0) {
		hasFacts = true;
		sections.add("open_loops");
		lines.push("- Open loops:");
		for (const loop of loops.slice(0, maxItems)) {
			lines.push(`  - ${loop.reason}: ${loop.summary}`);
			eventIds.add(loop.rootEventId);
			if (loop.openedEventId) eventIds.add(loop.openedEventId);
		}
	}

	const openPromises = karma.promises.filter((promise) => promise.state !== "resolved");
	if (openPromises.length > 0) {
		hasFacts = true;
		sections.add("open_commitments");
		lines.push("- Open commitments:");
		for (const promise of openPromises.slice(0, maxItems)) {
			const due = promise.dueTime ? ` due ${promise.dueTime}` : "";
			lines.push(`  - ${promise.state}${due}: ${promise.summary}`);
			eventIds.add(promise.lastEventId);
		}
	}

	const duePredictions = karma.predictions.filter((prediction) => prediction.state === "due");
	if (duePredictions.length > 0) {
		hasFacts = true;
		sections.add("due_predictions");
		lines.push("- Due predictions:");
		for (const prediction of duePredictions.slice(0, maxItems)) {
			lines.push(`  - ${prediction.claim}`);
			eventIds.add(prediction.lastEventId);
		}
	}

	if (preferences.length > 0) {
		hasFacts = true;
		sections.add("user_preferences");
		lines.push(`- User preferences: ${preferences.map((item) => item.text).join("; ")}`);
		for (const item of preferences) eventIds.add(item.eventId);
	}

	if (collaborationHints.length > 0) {
		hasFacts = true;
		sections.add("collaboration_hints");
		lines.push(`- Collaboration hints: ${collaborationHints.map((item) => item.text).join("; ")}`);
		for (const item of collaborationHints) eventIds.add(item.eventId);
	}

	if (corrections.length > 0) {
		hasFacts = true;
		sections.add("prior_corrections");
		lines.push(`- Prior corrections: ${corrections.map((item) => item.text).join("; ")}`);
		for (const item of corrections) eventIds.add(item.eventId);
	}

	const dueCallbacks = unresolvedDueCallbacks(options.projectTimeline?.events ?? options.sessionEvents).slice(
		0,
		maxItems,
	);
	if (dueCallbacks.length > 0) {
		hasFacts = true;
		sections.add("due_callbacks");
		lines.push("- Due callbacks:");
		for (const callback of dueCallbacks) {
			lines.push(`  - ${callback.summary}`);
			eventIds.add(callback.eventId);
			if (callback.targetEventId) eventIds.add(callback.targetEventId);
		}
	}

	lines.push(
		"- Operating policy: continue unresolved causal chains unless the user changed goals; validate modified artifacts before closing; use prior corrections to adjust new predictions.",
	);
	lines.push("</akasha_action_gate>");

	if (!hasFacts) return undefined;
	return {
		text: lines.join("\n"),
		eventIds: [...eventIds],
		sections: [...sections],
		tokenEstimate: estimateTokens(lines.join("\n")),
	};
}

function unresolvedDueCallbacks(events: AkashaEvent[]): Array<{
	eventId: string;
	callbackId: string;
	summary: string;
	targetEventId?: string;
}> {
	const completed = new Set<string>();
	const cancelled = new Set<string>();
	for (const event of events) {
		if (event.kind === "time.callback.completed" && typeof event.payload.callbackId === "string") {
			completed.add(event.payload.callbackId);
		}
		if (event.kind === "time.callback.cancelled" && typeof event.payload.callbackId === "string") {
			cancelled.add(event.payload.callbackId);
		}
	}
	return events.flatMap((event) => {
		if (event.kind !== "time.callback.due" || typeof event.payload.callbackId !== "string") return [];
		if (completed.has(event.payload.callbackId) || cancelled.has(event.payload.callbackId)) return [];
		return [
			{
				eventId: event.eventId,
				callbackId: event.payload.callbackId,
				summary: typeof event.payload.summary === "string" ? event.payload.summary : event.payload.callbackId,
				targetEventId:
					typeof event.payload.targetEventId === "string" ? event.payload.targetEventId : event.objectId,
			},
		];
	});
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}
