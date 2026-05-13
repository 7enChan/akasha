import type { AkashaEvent } from "./types.js";

export interface AkashaMemoryRecallScope {
	turnId?: string;
	actionGateEventId?: string;
	correlationId?: string;
	expiresAfterTurn: boolean;
}

export function createAkashaMemoryRecallScope(input: {
	turnId?: string;
	actionGateEventId?: string;
	correlationId?: string;
	expiresAfterTurn?: boolean;
}): AkashaMemoryRecallScope {
	return {
		turnId: input.turnId,
		actionGateEventId: input.actionGateEventId,
		correlationId: input.correlationId,
		expiresAfterTurn: input.expiresAfterTurn ?? true,
	};
}

export function readAkashaMemoryRecallScope(event: AkashaEvent | undefined): AkashaMemoryRecallScope | undefined {
	const scope = event?.payload.scope;
	if (!scope || typeof scope !== "object") return undefined;
	const record = scope as Record<string, unknown>;
	return {
		turnId: stringValue(record.turnId),
		actionGateEventId: stringValue(record.actionGateEventId),
		correlationId: stringValue(record.correlationId),
		expiresAfterTurn: record.expiresAfterTurn !== false,
	};
}

export function akashaRecallScopeMatches(input: {
	scope?: AkashaMemoryRecallScope;
	currentTurnEventId?: string;
	correlationId?: string;
	actionGateEventId?: string;
}): boolean {
	const scope = input.scope;
	if (!scope) return false;
	if (scope.expiresAfterTurn && scope.turnId && scope.turnId !== input.currentTurnEventId) return false;
	if (scope.actionGateEventId && input.actionGateEventId && scope.actionGateEventId === input.actionGateEventId) {
		return true;
	}
	if (scope.correlationId && input.correlationId && scope.correlationId === input.correlationId) return true;
	if (scope.turnId && input.currentTurnEventId && scope.turnId === input.currentTurnEventId) return true;
	return false;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
