import type { ExtensionAPI } from "../extensions/types.js";
import type { ResolvedAkashaReflectionSettings } from "../settings-manager.js";
import { SettingsManager } from "../settings-manager.js";
import { buildAkashaActionGateContext } from "./action-gate.js";
import {
	appendAkashaCallbackInboxEvent,
	appendAkashaCallbackInboxStatus,
	listAkashaActionableCallbackPrompts,
} from "./callback-inbox.js";
import { buildRunnableCallbacks, runAkashaCallbackRunner } from "./callback-runner.js";
import type { AkashaDaemonQueueItem } from "./daemon-queue.js";
import {
	buildAkashaDaemonQueue,
	markAkashaCallbackCancelled,
	markAkashaCallbackCompleted,
	runAkashaDaemonQueuePass,
} from "./daemon-queue.js";
import type { AkashaDoctorReport } from "./doctor.js";
import { buildAkashaDoctorReport } from "./doctor.js";
import { JsonlAkashaStore } from "./jsonl-store.js";
import type { AkashaKarmaLedger } from "./karma-ledger.js";
import { buildKarmaLedger } from "./karma-ledger.js";
import { runAkashaDetachedMaintenance } from "./maintenance-runner.js";
import { createMemoryGovernanceEvent } from "./memory-governance.js";
import type { AkashaOpenLoopRecord } from "./open-loops.js";
import { buildOpenLoopLedger } from "./open-loops.js";
import { buildAkashaProjectTimeline, summarizeProjectTimeline } from "./project-timeline.js";
import {
	buildCachedAkashaTemporalStateSnapshot,
	clearAkashaProjectionCache,
	getAkashaProjectionCacheFreshness,
	sessionStateProjectionCacheKey,
} from "./projection-cache.js";
import { createRedactionEvent } from "./redaction.js";
import type { AkashaRetentionPlan } from "./retention.js";
import { planAkashaRetention } from "./retention.js";
import { runAkashaSchedulerPass } from "./scheduler.js";
import { buildAkashaSessionIndex } from "./session-index.js";
import type { AkashaTaskModel } from "./task-model.js";
import { buildAkashaTaskModel } from "./task-model.js";
import type { AkashaOpenLoopCandidate, AkashaTemporalState } from "./temporal-state.js";
import { buildTemporalState } from "./temporal-state.js";
import type { AkashaEvent, AkashaStore } from "./types.js";
import type { AkashaUserTimeline } from "./user-timeline.js";
import { buildAkashaUserTimeline, summarizeUserTimeline } from "./user-timeline.js";
import type { AkashaProjectState } from "./world-model.js";
import { buildProjectState } from "./world-model.js";

export interface AkashaCommandOptions {
	agentDir: string;
	eventLogDir?: string;
	reflection: ResolvedAkashaReflectionSettings;
}

export function registerAkashaCommands(
	akasha: ExtensionAPI,
	getStore: () => AkashaStore | undefined,
	options?: AkashaCommandOptions,
): void {
	akasha.registerCommand("akasha", {
		description:
			"Inspect Akasha time events: /akasha status | init [global] | enable [global] | timeline [n] | project-timeline [n] | user-timeline | action-gate | queue | daemon [status|tick|run] | cache [status|clear|rebuild] | callback-complete <callbackId> [evidenceEventId] | callback-cancel <callbackId> [reason] | maintain [session|project|all] | memory-review | memory-pin <eventId> | memory-unpin <eventId> | memory-suppress <eventId> | redact <eventId> <field> [reason] | why <eventId|toolCallId> | explain-current | open-loops | project-state [project] | task-model | karma | scheduler | governance | doctor",
		getArgumentCompletions: (prefix) => {
			const commands = [
				"status",
				"init",
				"enable",
				"timeline",
				"project-timeline",
				"user-timeline",
				"action-gate",
				"queue",
				"daemon",
				"cache",
				"callback-complete",
				"callback-cancel",
				"maintain",
				"memory-review",
				"memory-pin",
				"memory-unpin",
				"memory-suppress",
				"redact",
				"why",
				"explain-current",
				"open-loops",
				"project-state",
				"task-model",
				"karma",
				"scheduler",
				"governance",
				"doctor",
			];
			const filtered = commands.filter((command) => command.startsWith(prefix.trim()));
			return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const [subcommand = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const store = getStore();
			if (!store) {
				ctx.ui.notify("Akasha is enabled but no session event store is ready yet.", "warning");
				return;
			}

			if (subcommand === "status") {
				const count = store.listRecent({ limit: Number.MAX_SAFE_INTEGER }).length;
				ctx.ui.notify(`Akasha enabled\nEvents: ${count}\nLog: ${store.eventLogPath}`, "info");
				return;
			}

			if (subcommand === "init" || subcommand === "enable") {
				if (!options) {
					ctx.ui.notify("Akasha settings preset is unavailable without command options.", "warning");
					return;
				}
				const scope = rest[0] === "global" || rest[0] === "--global" ? "global" : "project";
				const manager = SettingsManager.create(ctx.cwd, options.agentDir);
				manager.applyAkashaDogfoodPreset(scope);
				await manager.flush();
				ctx.ui.notify(`Akasha ${subcommand === "init" ? "initialized" : "enabled"} in ${scope} settings.`, "info");
				return;
			}

			if (subcommand === "timeline") {
				const limit = parsePositiveInt(rest[0], 20);
				const events = store.buildTimeline({ limit });
				ctx.ui.notify(
					events.length > 0 ? events.map(formatEvent).join("\n") : "No Akasha events recorded.",
					"info",
				);
				return;
			}

			if (subcommand === "project-timeline") {
				if (!options) {
					ctx.ui.notify("Akasha project timeline is unavailable without command options.", "warning");
					return;
				}
				const limit = parsePositiveInt(rest[0], 30);
				const timeline = buildAkashaProjectTimeline({
					agentDir: options.agentDir,
					eventLogDir: options.eventLogDir,
					cwd: ctx.cwd,
					limit,
				});
				const events = timeline.events.slice(-limit);
				ctx.ui.notify(
					[
						`Project timeline: ${timeline.sessions.length} sessions, ${events.length} events shown`,
						...events.map(formatProjectEvent),
					].join("\n"),
					"info",
				);
				return;
			}

			if (subcommand === "user-timeline") {
				if (!options) {
					ctx.ui.notify("Akasha user timeline is unavailable without command options.", "warning");
					return;
				}
				ctx.ui.notify(
					summarizeUserTimeline(
						buildAkashaUserTimeline({
							agentDir: options.agentDir,
							eventLogDir: options.eventLogDir,
							limit: 1000,
						}),
					),
					"info",
				);
				return;
			}

			if (subcommand === "action-gate") {
				const projectTimeline = options
					? buildAkashaProjectTimeline({
							agentDir: options.agentDir,
							eventLogDir: options.eventLogDir,
							cwd: ctx.cwd,
							limit: 1000,
						})
					: undefined;
				const userTimeline = options
					? buildAkashaUserTimeline({
							agentDir: options.agentDir,
							eventLogDir: options.eventLogDir,
							limit: 1000,
						})
					: undefined;
				const gate = buildAkashaActionGateContext({
					sessionEvents: store.buildTimeline({ limit: 500 }),
					projectTimeline,
					userTimeline,
				});
				ctx.ui.notify(gate?.text ?? "No Akasha action gate context is currently due.", "info");
				return;
			}

			if (subcommand === "queue") {
				if (!options) {
					ctx.ui.notify("Akasha daemon queue is unavailable without command options.", "warning");
					return;
				}
				ctx.ui.notify(
					formatDaemonQueue(
						buildAkashaDaemonQueue(store.buildTimeline({ limit: 1000 }), {
							reflection: options.reflection,
						}),
					),
					"info",
				);
				return;
			}

			if (subcommand === "daemon") {
				if (!options) {
					ctx.ui.notify("Akasha daemon is unavailable without command options.", "warning");
					return;
				}
				const action = rest[0] ?? "status";
				if (action === "status") {
					const queue = buildAkashaDaemonQueue(store.buildTimeline({ limit: 1000 }), {
						reflection: options.reflection,
					});
					const runnable = buildRunnableCallbacks(store.buildTimeline({ limit: 1000 }));
					ctx.ui.notify(formatDaemonStatus(queue, runnable.length), "info");
					return;
				}
				if (action === "tick") {
					const result = runAkashaDaemonQueuePass(store, { reflection: options.reflection });
					ctx.ui.notify(
						[
							"Akasha daemon tick:",
							`- scheduled callbacks: ${result.scheduledCallbacks.length}`,
							`- due callbacks: ${result.dueCallbacks.length}`,
							`- queue items: ${result.queue.length}`,
							`- tick event: ${result.tick.eventId}`,
						].join("\n"),
						"info",
					);
					return;
				}
				if (action === "run") {
					const result = runAkashaCallbackRunner(store, { reflection: options.reflection });
					ctx.ui.notify(
						[
							"Akasha daemon run:",
							`- claimed: ${result.claimed.length}`,
							`- dispatched: ${result.dispatched.length}`,
							`- failed: ${result.failed.length}`,
							`- policies: ${result.policies.length}`,
						].join("\n"),
						result.failed.length > 0 ? "warning" : "info",
					);
					return;
				}
				ctx.ui.notify("Usage: /akasha daemon status | tick | run", "warning");
				return;
			}

			if (subcommand === "cache") {
				if (!options) {
					ctx.ui.notify("Akasha cache is unavailable without command options.", "warning");
					return;
				}
				const action = rest[0] ?? "status";
				const cacheOptions = {
					agentDir: options.agentDir,
					eventLogDir: options.eventLogDir,
					scope: "session" as const,
					cacheKey: sessionStateProjectionCacheKey(store, 1000),
					sourceLogPaths: [store.eventLogPath],
				};
				if (action === "status") {
					ctx.ui.notify(formatCacheFreshness(getAkashaProjectionCacheFreshness(cacheOptions)), "info");
					return;
				}
				if (action === "clear") {
					const cleared = clearAkashaProjectionCache(cacheOptions);
					ctx.ui.notify(
						cleared ? "Akasha projection cache cleared." : "No Akasha projection cache to clear.",
						"info",
					);
					return;
				}
				if (action === "rebuild") {
					clearAkashaProjectionCache(cacheOptions);
					const rebuilt = buildCachedAkashaTemporalStateSnapshot(store, {
						agentDir: options.agentDir,
						eventLogDir: options.eventLogDir,
						limit: 1000,
					});
					ctx.ui.notify(formatCacheFreshness(rebuilt.freshness), "info");
					return;
				}
				ctx.ui.notify("Usage: /akasha cache status | clear | rebuild", "warning");
				return;
			}

			if (subcommand === "callback-complete") {
				const callbackId = rest[0];
				if (!callbackId) {
					ctx.ui.notify("Usage: /akasha callback-complete <callbackId> [evidenceEventId]", "warning");
					return;
				}
				const evidenceEventId = rest[1];
				const event = markAkashaCallbackCompleted(store, callbackId, {
					evidenceEventId,
					reason: "user_completed",
				});
				consumeInboxForCallback(store, options?.agentDir, callbackId, "consumed", event.eventId);
				ctx.ui.notify(`Callback completed: ${callbackId} -> ${event.eventId}`, "info");
				return;
			}

			if (subcommand === "callback-cancel") {
				const callbackId = rest[0];
				if (!callbackId) {
					ctx.ui.notify("Usage: /akasha callback-cancel <callbackId> [reason]", "warning");
					return;
				}
				const reason = rest.slice(1).join(" ") || "user_cancelled";
				const event = markAkashaCallbackCancelled(store, callbackId, { reason });
				consumeInboxForCallback(store, options?.agentDir, callbackId, "cancelled", event.eventId, reason);
				ctx.ui.notify(`Callback cancelled: ${callbackId} -> ${event.eventId}`, "info");
				return;
			}

			if (subcommand === "maintain") {
				if (!options) {
					ctx.ui.notify("Akasha detached maintenance is unavailable without command options.", "warning");
					return;
				}
				const requestedScope = rest[0] === "project" || rest[0] === "all" ? rest[0] : "session";
				const currentSessionId = store.buildTimeline({ limit: 1 }).at(-1)?.sessionId;
				const result = await runAkashaDetachedMaintenance({
					agentDir: options.agentDir,
					eventLogDir: options.eventLogDir,
					cwd: requestedScope === "project" ? ctx.cwd : undefined,
					sessionId: requestedScope === "session" ? currentSessionId : undefined,
					scope: requestedScope,
					reflection: options.reflection,
				});
				ctx.ui.notify(formatDetachedMaintenanceResult(result), result.errors.length > 0 ? "warning" : "info");
				return;
			}

			if (subcommand === "memory-review") {
				if (!options) {
					ctx.ui.notify("Akasha memory review is unavailable without command options.", "warning");
					return;
				}
				ctx.ui.notify(
					formatMemoryReview(
						buildAkashaUserTimeline({
							agentDir: options.agentDir,
							eventLogDir: options.eventLogDir,
							limit: 1000,
						}),
					),
					"info",
				);
				return;
			}

			if (subcommand === "memory-pin" || subcommand === "memory-unpin" || subcommand === "memory-suppress") {
				if (!options) {
					ctx.ui.notify("Akasha memory governance is unavailable without command options.", "warning");
					return;
				}
				const id = rest[0];
				if (!id) {
					ctx.ui.notify(`Usage: /akasha ${subcommand} <eventId> [reason]`, "warning");
					return;
				}
				const target = findEventForMutation(store, id, options);
				if (!target) {
					ctx.ui.notify(`No Akasha event found for ${id}.`, "warning");
					return;
				}
				const action = subcommand === "memory-pin" ? "pin" : subcommand === "memory-unpin" ? "unpin" : "suppress";
				const reason = rest.slice(1).join(" ") || "user_requested";
				const event = target.store.append(createMemoryGovernanceEvent(target.event, action, reason));
				ctx.ui.notify(`${subcommand} recorded for ${target.event.eventId}: ${event.eventId}`, "info");
				return;
			}

			if (subcommand === "redact") {
				if (!options) {
					ctx.ui.notify("Akasha redaction is unavailable without command options.", "warning");
					return;
				}
				const id = rest[0];
				const field = rest[1];
				if (!id || !field) {
					ctx.ui.notify(
						"Usage: /akasha redact <eventId> <payload|payload.field|objectId|subjectId> [reason]",
						"warning",
					);
					return;
				}
				const target = findEventForMutation(store, id, options);
				if (!target) {
					ctx.ui.notify(`No Akasha event found for ${id}.`, "warning");
					return;
				}
				const fields = field
					.split(",")
					.map((item) => item.trim())
					.filter(Boolean);
				const reason = rest.slice(2).join(" ") || "user_requested";
				const event = target.store.append(createRedactionEvent(target.event, fields, reason));
				ctx.ui.notify(`Redaction recorded for ${target.event.eventId}: ${event.eventId}`, "info");
				return;
			}

			if (subcommand === "why") {
				const id = rest[0];
				if (!id) {
					ctx.ui.notify("Usage: /akasha why <eventId|toolCallId>", "warning");
					return;
				}
				const chain = store.explainChain(id);
				ctx.ui.notify(
					chain.length > 0 ? chain.map(formatEvent).join("\n") : `No causal chain found for ${id}.`,
					"info",
				);
				return;
			}

			if (subcommand === "explain-current") {
				const state = buildTemporalState(store.buildTimeline({ limit: 200 }));
				ctx.ui.notify(formatTemporalState(state), "info");
				return;
			}

			if (subcommand === "open-loops") {
				const events = store.buildTimeline({ limit: 200 });
				const ledger = buildOpenLoopLedger(events);
				if (ledger.length > 0) {
					ctx.ui.notify(formatOpenLoopLedger(ledger), "info");
					return;
				}
				const state = buildTemporalState(events);
				ctx.ui.notify(formatOpenLoopCandidates(state.openLoopCandidates), "info");
				return;
			}

			if (subcommand === "project-state") {
				if (rest[0] === "project") {
					if (!options) {
						ctx.ui.notify("Akasha project state is unavailable without command options.", "warning");
						return;
					}
					ctx.ui.notify(
						summarizeProjectTimeline(
							buildAkashaProjectTimeline({
								agentDir: options.agentDir,
								eventLogDir: options.eventLogDir,
								cwd: ctx.cwd,
							}),
						),
						"info",
					);
					return;
				}
				const state = options
					? buildCachedAkashaTemporalStateSnapshot(store, {
							agentDir: options.agentDir,
							eventLogDir: options.eventLogDir,
							limit: 500,
						}).value.project
					: buildProjectState(store.buildTimeline({ limit: 500 }));
				ctx.ui.notify(formatProjectState(state), "info");
				return;
			}

			if (subcommand === "task-model") {
				const model = options
					? buildCachedAkashaTemporalStateSnapshot(store, {
							agentDir: options.agentDir,
							eventLogDir: options.eventLogDir,
							limit: 1000,
						}).value.taskModel
					: buildAkashaTaskModel(store.buildTimeline({ limit: 1000 }));
				ctx.ui.notify(formatTaskModel(model), "info");
				return;
			}

			if (subcommand === "karma") {
				ctx.ui.notify(formatKarmaLedger(buildKarmaLedger(store.buildTimeline({ limit: 1000 }))), "info");
				return;
			}

			if (subcommand === "scheduler") {
				const result = runAkashaSchedulerPass(store, { limit: 1000 });
				ctx.ui.notify(
					[
						"Akasha scheduler:",
						`- appended: ${result.appended.length}`,
						`- overdue promises: ${result.overduePromises}`,
						`- due predictions: ${result.duePredictions}`,
						`- checked predictions: ${result.checkedPredictions}`,
						`- corrected predictions: ${result.correctedPredictions}`,
					].join("\n"),
					"info",
				);
				return;
			}

			if (subcommand === "governance") {
				ctx.ui.notify(formatRetentionPlan(planAkashaRetention(store.buildTimeline({ limit: 1000 }))), "info");
				return;
			}

			if (subcommand === "doctor") {
				ctx.ui.notify(
					formatDoctorReport(
						buildAkashaDoctorReport(
							store,
							undefined,
							options
								? {
										agentDir: options.agentDir,
										eventLogDir: options.eventLogDir,
										limit: 1000,
									}
								: undefined,
						),
					),
					"info",
				);
				return;
			}

			ctx.ui.notify(
				"Usage: /akasha status | init [global] | enable [global] | timeline [n] | project-timeline [n] | user-timeline | action-gate | queue | daemon [status|tick|run] | cache [status|clear|rebuild] | callback-complete <callbackId> [evidenceEventId] | callback-cancel <callbackId> [reason] | maintain [session|project|all] | memory-review | memory-pin <eventId> | memory-unpin <eventId> | memory-suppress <eventId> | redact <eventId> <field> [reason] | why <eventId|toolCallId> | explain-current | open-loops | project-state [project] | task-model | karma | scheduler | governance | doctor",
				"warning",
			);
		},
	});
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
	const parsed = value ? Number.parseInt(value, 10) : NaN;
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return Math.min(parsed, 100);
}

function formatEvent(event: AkashaEvent): string {
	const target = event.objectId ? ` ${event.objectId}` : "";
	const tool = event.toolCallId ? ` [${event.toolCallId}]` : "";
	const parents = event.parentEventIds.length > 0 ? ` <- ${event.parentEventIds.join(",")}` : "";
	return `#${event.sequence} ${event.kind}${target}${tool}${parents}`;
}

function formatProjectEvent(event: AkashaEvent): string {
	const target = event.objectId ? ` ${event.objectId}` : "";
	const tool = event.toolCallId ? ` [${event.toolCallId}]` : "";
	return `${event.eventTime} ${event.sessionId}#${event.sequence} ${event.kind}${target}${tool}`;
}

function consumeInboxForCallback(
	store: AkashaStore,
	agentDir: string | undefined,
	callbackId: string,
	status: "consumed" | "cancelled",
	parentEventId: string,
	reason?: string,
): void {
	if (!agentDir) return;
	for (const item of listAkashaActionableCallbackPrompts(agentDir).filter(
		(candidate) => candidate.prompt.callbackId === callbackId,
	)) {
		const event = appendAkashaCallbackInboxEvent(
			store,
			status === "consumed" ? "callback.inbox.consumed" : "callback.inbox.cancelled",
			item.prompt,
			{
				parentEventIds: [parentEventId, item.prompt.claimEventId, item.prompt.dueEventId],
				sourceKeySuffix: `callback-command:${parentEventId}`,
				reason,
			},
		);
		appendAkashaCallbackInboxStatus(agentDir, item.prompt, {
			status,
			eventId: event.eventId,
			consumerSessionId: event.sessionId,
			reason,
		});
	}
}

function formatTemporalState(state: AkashaTemporalState): string {
	const lines = ["Current intent:", state.currentIntent?.text || "(none)", "", "Active files:"];
	if (state.activeFiles.length === 0) {
		lines.push("- (none)");
	} else {
		for (const file of state.activeFiles.slice(0, 10)) {
			const validation = file.hasUnverifiedChange ? "unverified" : "verified-or-read";
			lines.push(`- ${file.path} (${file.lastKind}, ${validation})`);
		}
	}

	lines.push("", "Failed tools:");
	if (state.failedTools.length === 0) {
		lines.push("- (none)");
	} else {
		for (const tool of state.failedTools.slice(0, 10)) {
			const id = tool.toolCallId ? ` [${tool.toolCallId}]` : "";
			lines.push(`- ${tool.toolName}${id}: ${tool.text || "(no output preview)"}`);
		}
	}

	lines.push("", "Open loops:");
	if (state.openLoopCandidates.length === 0) {
		lines.push("- (none)");
	} else {
		for (const loop of state.openLoopCandidates.slice(0, 10)) {
			lines.push(`- ${loop.reason}: ${loop.summary}`);
		}
	}

	if (state.lastCompactionEventId) {
		lines.push("", `Last compaction: ${state.lastCompactionEventId}`);
	}
	if (state.lastBranchSummaryEventId) {
		lines.push("", `Last branch summary: ${state.lastBranchSummaryEventId}`);
	}

	return lines.join("\n");
}

function formatOpenLoopCandidates(loops: AkashaOpenLoopCandidate[]): string {
	if (loops.length === 0) return "Open loops:\n- (none)";
	return ["Open loops:", ...loops.map((loop) => `- ${loop.reason}: ${loop.summary}`)].join("\n");
}

function formatOpenLoopLedger(loops: AkashaOpenLoopRecord[]): string {
	return [
		"Open loops:",
		...loops.map((loop) => {
			const target = loop.objectId ? ` ${loop.objectId}` : "";
			return `- ${loop.state} ${loop.reason}${target}: ${loop.summary}`;
		}),
	].join("\n");
}

function formatProjectState(state: AkashaProjectState): string {
	const lines = ["Current goal:", state.currentGoal || "(none)", "", "Active files:"];
	if (state.activeFiles.length === 0) {
		lines.push("- (none)");
	} else {
		for (const file of state.activeFiles.slice(0, 10)) {
			lines.push(`- ${file.path} (${file.status})`);
		}
	}

	lines.push("", "Blockers:");
	if (state.blockers.length === 0) {
		lines.push("- (none)");
	} else {
		for (const blocker of state.blockers.slice(0, 10)) {
			const target = blocker.objectId ? ` ${blocker.objectId}` : "";
			lines.push(`- ${blocker.reason}${target}: ${blocker.summary}`);
		}
	}

	lines.push("", "Recent decisions:");
	if (state.recentDecisions.length === 0) {
		lines.push("- (none)");
	} else {
		for (const decision of state.recentDecisions.slice(0, 8)) {
			lines.push(`- ${decision.kind}: ${decision.text}`);
		}
	}

	return lines.join("\n");
}

function formatKarmaLedger(ledger: AkashaKarmaLedger): string {
	const lines = [
		`Karma: ${ledger.openPromiseCount} open promises, ${ledger.overduePromiseCount} overdue promises, ${ledger.duePredictionCount} due predictions, ${ledger.correctedPredictionCount} corrected predictions`,
		"",
		"Promises:",
	];
	if (ledger.promises.length === 0) {
		lines.push("- (none)");
	} else {
		for (const promise of ledger.promises.slice(0, 10)) {
			const due = promise.dueTime ? ` due ${promise.dueTime}` : "";
			lines.push(`- ${promise.state}${due}: ${promise.summary}`);
		}
	}

	lines.push("", "Predictions:");
	if (ledger.predictions.length === 0) {
		lines.push("- (none)");
	} else {
		for (const prediction of ledger.predictions.slice(0, 10)) {
			const checkAfter = prediction.checkAfter ? ` check ${prediction.checkAfter}` : "";
			lines.push(`- ${prediction.state}${checkAfter}: ${prediction.claim}`);
		}
	}
	return lines.join("\n");
}

function formatDaemonQueue(queue: AkashaDaemonQueueItem[]): string {
	const lines = [`Akasha daemon queue: ${queue.length} due callbacks`];
	if (queue.length === 0) {
		lines.push("- (none)");
		return lines.join("\n");
	}
	for (const item of queue.slice(0, 12)) {
		const target = item.targetEventId ? ` target=${item.targetEventId}` : "";
		lines.push(`- ${item.kind} due=${item.dueTime}${target}: ${item.summary}`);
	}
	return lines.join("\n");
}

function formatDaemonStatus(queue: AkashaDaemonQueueItem[], runnableCount: number): string {
	const lines = [`Akasha daemon status: ${queue.length} queue items, ${runnableCount} runnable callbacks`];
	for (const item of queue.slice(0, 8)) {
		const target = item.targetEventId ? ` target=${item.targetEventId}` : "";
		lines.push(`- ${item.kind} due=${item.dueTime}${target}: ${item.summary}`);
	}
	if (queue.length === 0) lines.push("- (none)");
	return lines.join("\n");
}

function formatCacheFreshness(freshness: ReturnType<typeof getAkashaProjectionCacheFreshness>): string {
	const lines = [
		`Akasha projection cache: ${freshness.status}`,
		`- path: ${freshness.cachePath}`,
		`- reason: ${freshness.reasons.length > 0 ? freshness.reasons.join("; ") : "fresh"}`,
	];
	if (freshness.metadata) {
		lines.push(
			`- source logs: ${freshness.metadata.sourceLogPaths.length}`,
			`- events: ${freshness.metadata.highWaterMark.eventCount}`,
			`- updated: ${freshness.metadata.updatedTime}`,
		);
	}
	return lines.join("\n");
}

function formatTaskModel(model: AkashaTaskModel): string {
	const lines = [
		`Task model: ${model.goals.length} goals, ${model.tasks.length} tasks, ${model.decisions.length} decisions, ${model.risks.length} risks, ${model.graph.nodes.length} graph nodes, ${model.graph.edges.length} graph edges`,
		"",
		"Goals:",
	];
	if (model.goals.length === 0) {
		lines.push("- (none)");
	} else {
		for (const goal of model.goals.slice(0, 6)) {
			lines.push(`- ${goal.status}: ${goal.text}`);
		}
	}

	lines.push("", "Tasks:");
	if (model.tasks.length === 0) {
		lines.push("- (none)");
	} else {
		for (const task of model.tasks.slice(0, 8)) {
			const due = task.dueTime ? ` due ${task.dueTime}` : "";
			lines.push(`- ${task.status}${due}: ${task.text}`);
		}
	}

	lines.push("", "Risks:");
	if (model.risks.length === 0) {
		lines.push("- (none)");
	} else {
		for (const risk of model.risks.slice(0, 8)) {
			const target = risk.objectId ? ` ${risk.objectId}` : "";
			lines.push(`- ${risk.severity} ${risk.reason}${target}: ${risk.text}`);
		}
	}

	lines.push("", "Callbacks:");
	if (model.callbacks.length === 0) {
		lines.push("- (none)");
	} else {
		for (const callback of model.callbacks.slice(0, 8)) {
			const due = callback.dueTime ? ` due ${callback.dueTime}` : "";
			const target = callback.targetEventId ? ` target=${callback.targetEventId}` : "";
			lines.push(`- ${callback.status}${due}${target}: ${callback.text}`);
		}
	}

	lines.push("", "Decisions:");
	if (model.decisions.length === 0) {
		lines.push("- (none)");
	} else {
		for (const decision of model.decisions.slice(0, 8)) {
			lines.push(`- ${decision.kind}: ${decision.text}`);
		}
	}

	lines.push("", "Graph edges:");
	if (model.graph.edges.length === 0) {
		lines.push("- (none)");
	} else {
		for (const edge of model.graph.edges.slice(0, 12)) {
			const reason = edge.reason ? ` (${edge.reason})` : "";
			const source = edge.source ? ` source=${edge.source}` : "";
			const confidence = typeof edge.confidence === "number" ? ` confidence=${edge.confidence.toFixed(2)}` : "";
			lines.push(`- ${edge.type}: ${edge.from} -> ${edge.to}${reason}${source}${confidence}`);
		}
	}

	return lines.join("\n");
}

function formatRetentionPlan(plan: AkashaRetentionPlan): string {
	const lines = [
		`Governance: ${plan.keepCount} keep, ${plan.archiveCount} archive, ${plan.redactPayloadCount} redact payload`,
	];
	for (const decision of plan.decisions.filter((item) => item.action !== "keep").slice(0, 10)) {
		lines.push(`- ${decision.action} ${decision.eventId}: ${decision.reason}`);
	}
	if (lines.length === 1) lines.push("- no retention actions due");
	return lines.join("\n");
}

function formatDoctorReport(report: AkashaDoctorReport): string {
	const lines = [
		"Akasha doctor:",
		`- events: ${report.eventCount}`,
		`- schema issues: ${report.schemaIssueCount}`,
		`- redactions: ${report.redactionCount}`,
		`- retention archive due: ${report.retentionArchiveCount}`,
		`- retention payload redaction due: ${report.retentionRedactPayloadCount}`,
		`- last event: ${report.lastEventId ?? "(none)"}`,
	];
	if (report.projectionCache) {
		lines.push(
			`- projection cache: ${report.projectionCache.status} (${report.projectionCache.cachePath})`,
			`- projection cache reason: ${
				report.projectionCache.reasons.length > 0 ? report.projectionCache.reasons.join("; ") : "fresh"
			}`,
		);
	}
	return lines.join("\n");
}

function formatDetachedMaintenanceResult(result: Awaited<ReturnType<typeof runAkashaDetachedMaintenance>>): string {
	const lines = [
		"Akasha maintenance:",
		`- scope: ${result.scope}`,
		`- scanned sessions: ${result.scannedCount}`,
		`- maintained sessions: ${result.maintainedCount}`,
		`- appended events: ${result.appendedCount}`,
	];
	for (const session of result.sessions.slice(0, 8)) {
		const error = session.error ? ` error=${session.error}` : "";
		lines.push(
			`- ${session.sessionId}: appended=${session.appendedCount} callbacks=${session.dueCallbackCount} loops=${session.openLoopCount} scheduler=${session.schedulerCount} reflection=${session.reflectionCreated}${error}`,
		);
	}
	if (result.errors.length > 0) {
		lines.push("Errors:", ...result.errors.map((error) => `- ${error}`));
	}
	return lines.join("\n");
}

function formatMemoryReview(timeline: AkashaUserTimeline): string {
	const lines = [
		`Akasha memory review: ${timeline.events.length} events, ${timeline.pinnedEventIds.length} pinned, ${timeline.suppressedEventIds.length} suppressed`,
	];
	appendReviewFacts(lines, "Preferences", timeline.preferences);
	appendReviewFacts(lines, "Long-term goals", timeline.longTermGoals);
	appendReviewFacts(lines, "Collaboration hints", timeline.collaborationHints);
	appendReviewFacts(lines, "Open commitments", timeline.openCommitments);
	appendReviewFacts(lines, "Due predictions", timeline.duePredictions);
	appendReviewFacts(lines, "Corrections", timeline.corrections);
	return lines.join("\n");
}

function appendReviewFacts(lines: string[], label: string, facts: AkashaUserTimeline["preferences"]): void {
	lines.push("", `${label}:`);
	if (facts.length === 0) {
		lines.push("- (none)");
		return;
	}
	for (const fact of facts.slice(0, 10)) {
		lines.push(`- ${fact.eventId}${fact.pinned ? " [pinned]" : ""}: ${fact.text}`);
	}
}

function findEventForMutation(
	currentStore: AkashaStore,
	eventId: string,
	options: AkashaCommandOptions,
): { store: AkashaStore; event: AkashaEvent } | undefined {
	const current = currentStore.findById(eventId);
	if (current) return { store: currentStore, event: current };
	for (const entry of buildAkashaSessionIndex({ agentDir: options.agentDir, eventLogDir: options.eventLogDir })) {
		if (entry.eventLogPath === currentStore.eventLogPath) continue;
		const store = new JsonlAkashaStore(entry.eventLogPath);
		const event = store.findById(eventId);
		if (event) return { store, event };
	}
	return undefined;
}
