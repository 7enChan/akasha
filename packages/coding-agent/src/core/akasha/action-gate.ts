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
}

export function buildAkashaActionGateContext(options: AkashaActionGateOptions): AkashaActionGateContext | undefined {
	const maxItems = Math.max(1, Math.floor(options.maxItems ?? 8));
	const projectState = options.projectTimeline?.state ?? buildProjectState(options.sessionEvents);
	const loops = buildOpenLoopLedger(options.projectTimeline?.events ?? options.sessionEvents).filter(
		(loop) => loop.state !== "resolved",
	);
	const karma = buildKarmaLedger(options.userTimeline?.events ?? options.sessionEvents);
	const preferences = options.userTimeline?.preferences.slice(0, maxItems) ?? [];
	const collaborationHints = options.userTimeline?.collaborationHints.slice(0, maxItems) ?? [];
	const corrections = options.userTimeline?.corrections.slice(0, maxItems) ?? [];
	const eventIds = new Set<string>();

	const lines = ["<akasha_action_gate>", "Temporal control facts to consider before acting:"];
	let hasFacts = false;
	if (projectState.currentGoal) {
		hasFacts = true;
		lines.push(`- Current project goal: ${projectState.currentGoal}`);
		if (projectState.currentGoalEventId) eventIds.add(projectState.currentGoalEventId);
	}

	if (projectState.activeFiles.length > 0) {
		hasFacts = true;
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
		lines.push("- Due predictions:");
		for (const prediction of duePredictions.slice(0, maxItems)) {
			lines.push(`  - ${prediction.claim}`);
			eventIds.add(prediction.lastEventId);
		}
	}

	if (preferences.length > 0) {
		hasFacts = true;
		lines.push(`- User preferences: ${preferences.map((item) => item.text).join("; ")}`);
		for (const item of preferences) eventIds.add(item.eventId);
	}

	if (collaborationHints.length > 0) {
		hasFacts = true;
		lines.push(`- Collaboration hints: ${collaborationHints.map((item) => item.text).join("; ")}`);
		for (const item of collaborationHints) eventIds.add(item.eventId);
	}

	if (corrections.length > 0) {
		hasFacts = true;
		lines.push(`- Prior corrections: ${corrections.map((item) => item.text).join("; ")}`);
		for (const item of corrections) eventIds.add(item.eventId);
	}

	lines.push(
		"- Operating policy: continue unresolved causal chains unless the user changed goals; validate modified artifacts before closing; use prior corrections to adjust new predictions.",
	);
	lines.push("</akasha_action_gate>");

	if (!hasFacts) return undefined;
	return {
		text: lines.join("\n"),
		eventIds: [...eventIds],
	};
}
