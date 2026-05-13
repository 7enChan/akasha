import type { AkashaEvent } from "./types.js";

export interface AkashaProcedurePolicy {
	minConfidence: number;
	maxProcedures: number;
}

export const DEFAULT_AKASHA_PROCEDURE_POLICY: AkashaProcedurePolicy = {
	minConfidence: 0.55,
	maxProcedures: 8,
};

export function isValidationProcedureCommand(command: string): boolean {
	const normalized = command.toLowerCase();
	return /\b(test|vitest|jest|tsc|build|lint|typecheck|check)\b/.test(normalized);
}

export function commandSucceeded(event: AkashaEvent): boolean {
	return event.kind === "command.executed" && event.payload.exitCode === 0;
}

export function commandFailed(event: AkashaEvent): boolean {
	return (
		event.kind === "command.executed" && typeof event.payload.exitCode === "number" && event.payload.exitCode !== 0
	);
}
