import type { ResolvedAkashaReflectionSettings } from "../settings-manager.js";
import { runAkashaDaemonQueuePass } from "./daemon-queue.js";
import { JsonlAkashaStore } from "./jsonl-store.js";
import { runAkashaMaintenancePass } from "./maintenance.js";
import { buildAkashaSessionIndex } from "./session-index.js";

export type AkashaMaintenanceScope = "session" | "project" | "all";

export interface AkashaDetachedMaintenanceOptions {
	agentDir: string;
	eventLogDir?: string;
	cwd?: string;
	sessionId?: string;
	scope?: AkashaMaintenanceScope;
	reflection: ResolvedAkashaReflectionSettings;
	limit?: number;
	now?: Date;
}

export interface AkashaDetachedMaintenanceSessionResult {
	sessionId: string;
	eventLogPath: string;
	appendedCount: number;
	dueCallbackCount: number;
	openLoopCount: number;
	schedulerCount: number;
	embeddingIndexed: number;
	reflectionCreated: boolean;
	reflectionReason: string;
	error?: string;
}

export interface AkashaDetachedMaintenanceResult {
	scope: AkashaMaintenanceScope;
	scannedCount: number;
	maintainedCount: number;
	appendedCount: number;
	errors: string[];
	sessions: AkashaDetachedMaintenanceSessionResult[];
}

export async function runAkashaDetachedMaintenance(
	options: AkashaDetachedMaintenanceOptions,
): Promise<AkashaDetachedMaintenanceResult> {
	const scope = options.scope ?? (options.sessionId ? "session" : options.cwd ? "project" : "all");
	const sessions = buildAkashaSessionIndex({
		agentDir: options.agentDir,
		eventLogDir: options.eventLogDir,
		cwd: scope === "project" ? options.cwd : undefined,
	}).filter((entry) => scope !== "session" || !options.sessionId || entry.sessionId === options.sessionId);

	const results: AkashaDetachedMaintenanceSessionResult[] = [];
	for (const session of sessions) {
		const store = new JsonlAkashaStore(session.eventLogPath);
		try {
			const result = await runAkashaMaintenancePass(store, {
				sessionId: session.sessionId,
				streamId: `session:${session.sessionId}`,
				reflection: options.reflection,
				limit: options.limit,
				now: options.now,
			});
			const daemon = runAkashaDaemonQueuePass(store, {
				reflection: options.reflection,
				now: options.now,
			});
			const reflectionCount = result.reflection
				? 2 + result.reflection.crystals.length + result.reflection.memoryCrystals.length
				: 0;
			const appendedCount =
				result.openLoopEvents.length +
				result.schedulerEvents.length +
				reflectionCount +
				1 +
				daemon.dueCallbacks.length;
			results.push({
				sessionId: session.sessionId,
				eventLogPath: session.eventLogPath,
				appendedCount,
				dueCallbackCount: daemon.dueCallbacks.length,
				openLoopCount: result.openLoopEvents.length,
				schedulerCount: result.schedulerEvents.length,
				embeddingIndexed: result.embeddingIndexed,
				reflectionCreated: !!result.reflection,
				reflectionReason: result.reflectionReason,
			});
		} catch (error) {
			results.push({
				sessionId: session.sessionId,
				eventLogPath: session.eventLogPath,
				appendedCount: 0,
				dueCallbackCount: 0,
				openLoopCount: 0,
				schedulerCount: 0,
				embeddingIndexed: 0,
				reflectionCreated: false,
				reflectionReason: "error",
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	const errors = results.flatMap((result) => (result.error ? [`${result.sessionId}: ${result.error}`] : []));
	return {
		scope,
		scannedCount: sessions.length,
		maintainedCount: results.filter((result) => !result.error).length,
		appendedCount: results.reduce((sum, result) => sum + result.appendedCount, 0),
		errors,
		sessions: results,
	};
}
