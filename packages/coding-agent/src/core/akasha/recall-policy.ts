import { buildOpenLoopLedger } from "./open-loops.js";
import type { AkashaEvent } from "./types.js";

const KIND_PRIORITY: Partial<Record<AkashaEvent["kind"], number>> = {
	"artifact.patched": 10,
	"artifact.written": 10,
	"tool.blocked": 10,
	"time.callback.due": 10,
	"time.callback.scheduled": 8,
	"tool.completed": 9,
	"policy.evaluated": 9,
	"command.executed": 8,
	"message.user.submitted": 8,
	"action_gate.injected": 7,
	"context.compacted": 7,
	"branch.summary_created": 7,
	"message.agent.completed": 5,
	"artifact.read": 4,
};

export function rankRecallEvents(events: AkashaEvent[], queryText?: string): AkashaEvent[] {
	const query = queryText?.trim().toLowerCase();
	const recentOrder = [...events].sort((a, b) => b.sequence - a.sequence);
	const recencyIndex = new Map(recentOrder.map((event, index) => [event.eventId, index]));
	const ledger = buildOpenLoopLedger(events);
	const unresolvedRootIds = new Set(
		ledger.filter((loop) => loop.state !== "resolved").map((loop) => loop.rootEventId),
	);
	const resolvedRootIds = new Set(ledger.filter((loop) => loop.state === "resolved").map((loop) => loop.rootEventId));
	return [...events].sort((a, b) => {
		const aScore = scoreEvent(a, recencyIndex.get(a.eventId) ?? 0, query, unresolvedRootIds, resolvedRootIds);
		const bScore = scoreEvent(b, recencyIndex.get(b.eventId) ?? 0, query, unresolvedRootIds, resolvedRootIds);
		return bScore - aScore || b.sequence - a.sequence;
	});
}

export function scoreRecallEvent(event: AkashaEvent, queryText?: string): number {
	return scoreEvent(event, 0, queryText?.trim().toLowerCase(), new Set(), new Set());
}

function scoreEvent(
	event: AkashaEvent,
	recencyIndex: number,
	query: string | undefined,
	unresolvedRootIds: Set<string>,
	resolvedRootIds: Set<string>,
): number {
	let score = event.importance * 10 + (KIND_PRIORITY[event.kind] ?? 1);
	score += Math.max(0, 8 - recencyIndex * 0.25);
	if (event.kind === "tool.completed" && event.payload.isError === true) score += 8;
	if (event.kind === "tool.blocked") score += 8;
	if (event.kind === "time.callback.due") score += 8;
	if (event.kind === "policy.evaluated" && event.payload.action !== "allow") score += 6;
	if (event.kind === "artifact.patched" || event.kind === "artifact.written") score += 5;
	if (event.kind === "prediction.corrected" || event.kind === "failure.lesson_learned") score += 6;
	if (unresolvedRootIds.has(event.eventId)) score += 10;
	if (resolvedRootIds.has(event.eventId) || event.kind === "loop.resolved") score -= 18;
	if (query && JSON.stringify(event).toLowerCase().includes(query)) score += 6;
	return score;
}
