import { orderAkashaEvents } from "./ordering.js";
import type { AkashaEvent } from "./types.js";

export interface AkashaCurrentIntent {
	eventId: string;
	text: string;
	eventTime: string;
}

export interface AkashaActiveFile {
	path: string;
	lastEventId: string;
	lastKind: AkashaEvent["kind"];
	lastEventTime: string;
	lastSequence: number;
	hasUnverifiedChange: boolean;
	lastValidationEventId?: string;
}

export interface AkashaFailedTool {
	eventId: string;
	toolCallId: string | undefined;
	toolName: string;
	text: string;
	eventTime: string;
	sequence: number;
}

export type AkashaOpenLoopReason =
	| "artifact_changed_without_validation"
	| "tool_failed_without_recovery"
	| "user_requested_followup";

export interface AkashaOpenLoopCandidate {
	rootEventId: string;
	reason: AkashaOpenLoopReason;
	summary: string;
	objectId?: string;
	toolCallId?: string;
}

export interface AkashaTemporalState {
	currentIntent?: AkashaCurrentIntent;
	activeFiles: AkashaActiveFile[];
	failedTools: AkashaFailedTool[];
	openLoopCandidates: AkashaOpenLoopCandidate[];
	lastCompactionEventId?: string;
	lastBranchSummaryEventId?: string;
}

export function buildTemporalState(events: AkashaEvent[]): AkashaTemporalState {
	const ordered = orderAkashaEvents(events);
	const activeFiles = new Map<string, AkashaActiveFile>();
	const activeFileIndexes = new Map<string, number>();
	const unresolvedFailures = new Map<string, AkashaFailedTool>();
	let currentIntent: AkashaCurrentIntent | undefined;
	let lastCompactionEventId: string | undefined;
	let lastBranchSummaryEventId: string | undefined;
	let lastValidationEvent: AkashaEvent | undefined;
	let lastValidationIndex = -1;

	for (const [index, event] of ordered.entries()) {
		if (event.kind === "message.user.submitted") {
			currentIntent = {
				eventId: event.eventId,
				text: payloadText(event),
				eventTime: event.eventTime,
			};
		}

		if (isArtifactEvent(event)) {
			const path = artifactPath(event);
			if (path) {
				const changed = event.kind === "artifact.patched" || event.kind === "artifact.written";
				activeFiles.set(path, {
					path,
					lastEventId: event.eventId,
					lastKind: event.kind,
					lastEventTime: event.eventTime,
					lastSequence: event.sequence,
					hasUnverifiedChange:
						changed && event.payload.isError !== true && (!lastValidationEvent || lastValidationIndex < index),
					lastValidationEventId: lastValidationIndex > index ? lastValidationEvent?.eventId : undefined,
				});
				activeFileIndexes.set(path, index);
			}
		}

		if (isSuccessfulValidationCommand(event)) {
			lastValidationEvent = event;
			lastValidationIndex = index;
			for (const file of activeFiles.values()) {
				if ((activeFileIndexes.get(file.path) ?? -1) < index) {
					file.hasUnverifiedChange = false;
					file.lastValidationEventId = event.eventId;
				}
			}
		}

		if (event.kind === "tool.completed") {
			const toolName =
				typeof event.payload.toolName === "string" ? event.payload.toolName : (event.objectId ?? "tool");
			const failureKey = event.toolCallId ?? event.objectId ?? toolName;
			if (event.payload.isError === true) {
				unresolvedFailures.set(failureKey, {
					eventId: event.eventId,
					toolCallId: event.toolCallId,
					toolName,
					text: payloadText(event),
					eventTime: event.eventTime,
					sequence: event.sequence,
				});
			} else {
				for (const [key, failure] of unresolvedFailures) {
					if (key === failureKey || failure.toolName === toolName) {
						unresolvedFailures.delete(key);
					}
				}
			}
		}

		if (event.kind === "context.compacted") lastCompactionEventId = event.eventId;
		if (event.kind === "branch.summary_created") lastBranchSummaryEventId = event.eventId;
	}

	const openLoopCandidates: AkashaOpenLoopCandidate[] = [];
	for (const file of activeFiles.values()) {
		if (file.hasUnverifiedChange) {
			openLoopCandidates.push({
				rootEventId: file.lastEventId,
				reason: "artifact_changed_without_validation",
				summary: `${file.path} changed without a later validation command`,
				objectId: file.path,
			});
		}
	}

	for (const failure of unresolvedFailures.values()) {
		openLoopCandidates.push({
			rootEventId: failure.eventId,
			reason: "tool_failed_without_recovery",
			summary: `${failure.toolName} failed without a later successful recovery`,
			toolCallId: failure.toolCallId,
		});
	}

	if (currentIntent && looksLikeFollowupRequest(currentIntent.text)) {
		openLoopCandidates.push({
			rootEventId: currentIntent.eventId,
			reason: "user_requested_followup",
			summary: "User asked to continue or revisit this later",
		});
	}

	return {
		currentIntent,
		activeFiles: [...activeFiles.values()].sort(
			(a, b) => b.lastEventTime.localeCompare(a.lastEventTime) || b.lastSequence - a.lastSequence,
		),
		failedTools: [...unresolvedFailures.values()].sort(
			(a, b) => b.eventTime.localeCompare(a.eventTime) || b.sequence - a.sequence,
		),
		openLoopCandidates,
		lastCompactionEventId,
		lastBranchSummaryEventId,
	};
}

function isArtifactEvent(event: AkashaEvent): boolean {
	return event.kind === "artifact.read" || event.kind === "artifact.written" || event.kind === "artifact.patched";
}

function artifactPath(event: AkashaEvent): string | undefined {
	if (typeof event.payload.path === "string") return event.payload.path;
	return event.objectId;
}

function isSuccessfulValidationCommand(event: AkashaEvent): boolean {
	if (event.kind !== "command.executed" || event.payload.isError === true) return false;
	const command = typeof event.payload.command === "string" ? event.payload.command.toLowerCase() : "";
	return (
		command.includes("test") ||
		command.includes("vitest") ||
		command.includes("jest") ||
		command.includes("tsc") ||
		command.includes("build") ||
		command.includes("lint")
	);
}

function payloadText(event: AkashaEvent): string {
	const payload = event.payload;
	if (typeof payload.text === "string") return payload.text;
	if (typeof payload.summary === "string") return payload.summary;
	if (typeof payload.command === "string") return payload.command;
	if (typeof payload.path === "string") return payload.path;
	return "";
}

function looksLikeFollowupRequest(text: string): boolean {
	const normalized = text.toLowerCase();
	return (
		normalized.includes("later") ||
		normalized.includes("tomorrow") ||
		normalized.includes("follow up") ||
		normalized.includes("continue") ||
		text.includes("稍后") ||
		text.includes("之后") ||
		text.includes("明天") ||
		text.includes("回头") ||
		text.includes("继续")
	);
}
