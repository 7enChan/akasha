import type { AkashaEvent } from "./types.js";

export type AkashaValidationScope = "file" | "project" | "unknown";

export interface AkashaValidationInference {
	eventId: string;
	command: string;
	scope: AkashaValidationScope;
	targetPaths: string[];
	confidence: number;
}

const VALIDATION_KEYWORDS = ["test", "vitest", "jest", "tsc", "build", "lint", "typecheck", "check"];

export function inferValidationCommand(
	event: AkashaEvent,
	knownArtifactPaths: string[] = [],
): AkashaValidationInference | undefined {
	if (event.kind !== "command.executed" || event.payload.isError === true) return undefined;
	const command = typeof event.payload.command === "string" ? event.payload.command : "";
	if (!looksLikeValidationCommand(command)) return undefined;

	const targetPaths = knownArtifactPaths.filter((path) => commandReferencesPath(command, path));
	if (targetPaths.length > 0) {
		return {
			eventId: event.eventId,
			command,
			scope: "file",
			targetPaths,
			confidence: 0.85,
		};
	}

	return {
		eventId: event.eventId,
		command,
		scope: looksLikeProjectValidation(command) ? "project" : "unknown",
		targetPaths: [],
		confidence: looksLikeProjectValidation(command) ? 0.45 : 0.3,
	};
}

export function validationCoversArtifact(event: AkashaEvent, path: string, knownArtifactPaths: string[] = []): boolean {
	const inference = inferValidationCommand(
		event,
		knownArtifactPaths.includes(path) ? knownArtifactPaths : [...knownArtifactPaths, path],
	);
	return inference?.targetPaths.includes(path) ?? false;
}

export function looksLikeValidationCommand(command: string): boolean {
	const normalized = command.toLowerCase();
	return VALIDATION_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

function looksLikeProjectValidation(command: string): boolean {
	const normalized = command.toLowerCase().trim();
	return (
		/\bnpm\s+(run\s+)?(test|build|lint|typecheck|check)\b/.test(normalized) ||
		/\b(pnpm|yarn|bun)\s+(test|build|lint|typecheck|check)\b/.test(normalized) ||
		/\b(tsc|vitest|jest)\b/.test(normalized)
	);
}

function commandReferencesPath(command: string, path: string): boolean {
	const normalizedCommand = command.toLowerCase();
	const normalizedPath = path.toLowerCase();
	const basename = normalizedPath.split("/").pop() ?? normalizedPath;
	const stem = basename.replace(/\.[^.]+$/g, "");
	return (
		normalizedCommand.includes(normalizedPath) ||
		normalizedCommand.includes(basename) ||
		(stem.length >= 3 && normalizedCommand.includes(stem))
	);
}
