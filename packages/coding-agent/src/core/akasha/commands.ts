import type { ExtensionAPI } from "../extensions/types.js";
import type { AkashaDoctorReport } from "./doctor.js";
import { buildAkashaDoctorReport } from "./doctor.js";
import type { AkashaKarmaLedger } from "./karma-ledger.js";
import { buildKarmaLedger } from "./karma-ledger.js";
import type { AkashaOpenLoopRecord } from "./open-loops.js";
import { buildOpenLoopLedger } from "./open-loops.js";
import { buildAkashaProjectTimeline, summarizeProjectTimeline } from "./project-timeline.js";
import type { AkashaRetentionPlan } from "./retention.js";
import { planAkashaRetention } from "./retention.js";
import { runAkashaSchedulerPass } from "./scheduler.js";
import type { AkashaOpenLoopCandidate, AkashaTemporalState } from "./temporal-state.js";
import { buildTemporalState } from "./temporal-state.js";
import type { AkashaEvent, AkashaStore } from "./types.js";
import type { AkashaProjectState } from "./world-model.js";
import { buildProjectState } from "./world-model.js";

export interface AkashaCommandOptions {
	agentDir: string;
	eventLogDir?: string;
}

export function registerAkashaCommands(
	pi: ExtensionAPI,
	getStore: () => AkashaStore | undefined,
	options?: AkashaCommandOptions,
): void {
	pi.registerCommand("akasha", {
		description:
			"Inspect Akasha time events: /akasha status | timeline [n] | project-timeline [n] | why <eventId|toolCallId> | explain-current | open-loops | project-state [project] | karma | scheduler | governance | doctor",
		getArgumentCompletions: (prefix) => {
			const commands = [
				"status",
				"timeline",
				"project-timeline",
				"why",
				"explain-current",
				"open-loops",
				"project-state",
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
				ctx.ui.notify(formatProjectState(buildProjectState(store.buildTimeline({ limit: 500 }))), "info");
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
				ctx.ui.notify(formatDoctorReport(buildAkashaDoctorReport(store)), "info");
				return;
			}

			ctx.ui.notify(
				"Usage: /akasha status | timeline [n] | project-timeline [n] | why <eventId|toolCallId> | explain-current | open-loops | project-state [project] | karma | scheduler | governance | doctor",
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
	return [
		"Akasha doctor:",
		`- events: ${report.eventCount}`,
		`- schema issues: ${report.schemaIssueCount}`,
		`- redactions: ${report.redactionCount}`,
		`- retention archive due: ${report.retentionArchiveCount}`,
		`- retention payload redaction due: ${report.retentionRedactPayloadCount}`,
		`- last event: ${report.lastEventId ?? "(none)"}`,
	].join("\n");
}
