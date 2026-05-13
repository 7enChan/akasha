import { existsSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { CONFIG_DIR_NAME, getAgentDir } from "./config.js";
import {
	type AkashaCallbackInboxItem,
	appendAkashaCallbackInboxEvent,
	appendAkashaCallbackInboxStatus,
	listAkashaActionableCallbackPrompts,
	projectAkashaCallbackInbox,
} from "./core/akasha/callback-inbox.js";
import type { AkashaCallbackDispatchMode } from "./core/akasha/callback-runner.js";
import { buildRunnableCallbacks, runAkashaCallbackRunner } from "./core/akasha/callback-runner.js";
import { resolveAkashaEventLogPath } from "./core/akasha/collector-extension.js";
import { buildAkashaDaemonQueue, runAkashaDaemonQueuePass } from "./core/akasha/daemon-queue.js";
import { JsonlAkashaStore } from "./core/akasha/jsonl-store.js";
import { rulesForAkashaPolicyProfile } from "./core/akasha/policy-kernel.js";
import {
	buildCachedAkashaTemporalStateSnapshot,
	clearAkashaProjectionCache,
	getAkashaProjectionCacheFreshness,
	sessionStateProjectionCacheKey,
} from "./core/akasha/projection-cache.js";
import { buildAkashaSessionIndex } from "./core/akasha/session-index.js";
import type { AkashaStore } from "./core/akasha/types.js";
import { SettingsManager } from "./core/settings-manager.js";
import { resolveAkashaGatewayConfig } from "./gateway/config.js";
import { resolveAkashaGatewayEnvPath } from "./gateway/env.js";
import { createAkashaGatewayRunnerFromSettings } from "./gateway/runner.js";
import {
	installAkashaGatewayUserService,
	readAkashaGatewayJournal,
	runAkashaGatewaySystemctl,
	uninstallAkashaGatewayUserService,
} from "./gateway/systemd.js";

export async function handleAkashaEntrypointCommand(args: string[], cwd: string): Promise<boolean> {
	const [command] = args;
	if (
		command !== "init" &&
		command !== "enable" &&
		command !== "status" &&
		command !== "doctor" &&
		command !== "daemon" &&
		command !== "cache" &&
		command !== "inbox" &&
		command !== "gateway"
	) {
		return false;
	}

	if (args.includes("--help") || args.includes("-h")) {
		printAkashaEntrypointHelp(command);
		return true;
	}

	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const scope = args.includes("--global") ? "global" : "project";

	if (command === "daemon") {
		await handleAkashaDaemonCommand(args.slice(1), cwd, agentDir, settingsManager);
		return true;
	}

	if (command === "cache") {
		handleAkashaCacheCommand(args.slice(1), cwd, agentDir, settingsManager);
		return true;
	}

	if (command === "inbox") {
		handleAkashaInboxCommand(args.slice(1), agentDir, settingsManager);
		return true;
	}

	if (command === "gateway") {
		await handleAkashaGatewayCommand(args.slice(1), cwd, agentDir, settingsManager);
		return true;
	}

	if (command === "doctor") {
		const settings = settingsManager.getAkashaSettings();
		const gateway = resolveAkashaGatewayConfig({ agentDir, cwd, settings });
		console.log("Akasha doctor");
		console.log(chalk.green("Runtime paths: Akasha-only"));
		console.log(`Gateway: ${gateway.ok ? "ready" : "not ready"}`);
		if (gateway.missing.length > 0) console.log(`Gateway missing: ${gateway.missing.join(", ")}`);
		if (gateway.warnings.length > 0) console.log(`Gateway warnings: ${gateway.warnings.join("; ")}`);
		return true;
	}

	if (command === "init" || command === "enable") {
		settingsManager.applyAkashaDogfoodPreset(scope);
		await settingsManager.flush();
		const target = scope === "global" ? globalSettingsPath(agentDir) : projectSettingsPath(cwd);
		console.log(chalk.green(`Akasha ${command === "init" ? "initialized" : "enabled"} in ${scope} settings.`));
		console.log(chalk.dim(`Settings: ${target}`));
		console.log(chalk.dim("Run `akasha` to start the time-aware coding agent."));
		return true;
	}

	const settings = settingsManager.getAkashaSettings();
	const projectPath = projectSettingsPath(cwd);
	const globalPath = globalSettingsPath(agentDir);
	console.log("Akasha status");
	console.log(`- enabled: ${settings.enabled}`);
	console.log(`- temporal brief: ${settings.injectTemporalBrief}`);
	console.log(`- action gate: ${settings.actionGate.enabled}`);
	console.log(`- tool gate: ${settings.actionGate.enforceToolGate}`);
	console.log(`- maintenance: ${settings.maintenance.enabled}`);
	console.log(`- heartbeat: ${settings.maintenance.heartbeatEnabled}`);
	console.log(`- policy profile: ${settings.policyProfile}`);
	console.log(`- event log dir: ${settings.eventLogDir ?? join(agentDir, "akasha", "events")}`);
	console.log(`- project settings: ${projectPath}${existsSync(projectPath) ? "" : " (missing)"}`);
	console.log(`- global settings: ${globalPath}${existsSync(globalPath) ? "" : " (missing)"}`);
	return true;
}

function printAkashaEntrypointHelp(command?: string): void {
	const usage =
		command === "daemon"
			? "akasha daemon status|tick|run [--scope current|project|all] [--dispatch record_only|terminal_notification|agent_prompt_file|auto_run_safe]"
			: command === "cache"
				? "akasha cache status|clear|rebuild [--scope current|project|all]"
				: command === "inbox"
					? "akasha inbox status|list|run|consume [id|all]"
					: command === "gateway"
						? "akasha gateway [setup|status|run|install|uninstall|start|stop|logs]"
						: command === "doctor"
							? "akasha doctor"
							: command === "status"
								? "akasha status"
								: command === "enable"
									? "akasha enable [--global]"
									: "akasha init [--global]";
	console.log(`${chalk.bold("Akasha")} - time-native coding agent

${chalk.bold("Usage:")}
  ${usage}

${chalk.bold("Commands:")}
  akasha init [--global]    Write the Akasha dogfood preset
  akasha enable [--global]  Alias for init
  akasha status             Show resolved Akasha state
  akasha doctor             Check Akasha runtime health
  akasha daemon ...         Run Akasha daemon operations outside a session
  akasha cache ...          Inspect or rebuild Akasha projection caches
  akasha inbox ...          Inspect or consume pending callback prompts
  akasha gateway ...        Run the Telegram gateway and Linux service helpers
  akasha                    Start the agent runtime

By default init writes project settings at ${CONFIG_DIR_NAME}/settings.json.
Use --global to write ${CONFIG_DIR_NAME}/agent/settings.json instead.

Akasha stores local runtime state in ${CONFIG_DIR_NAME}.`);
}

async function handleAkashaGatewayCommand(
	args: string[],
	cwd: string,
	agentDir: string,
	settingsManager: SettingsManager,
): Promise<void> {
	const action = args[0] ?? "run";
	if (action === "setup") {
		settingsManager.applyAkashaGatewayPreset(cwd, "global");
		await settingsManager.flush();
		console.log(chalk.green("Akasha gateway settings written to global settings."));
		console.log(chalk.dim(`Secrets file: ${resolveAkashaGatewayEnvPath(agentDir)}`));
		console.log("Add at least:");
		console.log("TELEGRAM_BOT_TOKEN=...");
		console.log("TELEGRAM_ALLOWED_USERS=123456789");
		console.log("TELEGRAM_HOME_CHAT=123456789");
		return;
	}

	const settings = settingsManager.getAkashaSettings();
	const status = resolveAkashaGatewayConfig({ agentDir, cwd, settings });

	if (action === "status" && args.includes("--user")) {
		const result = runAkashaGatewaySystemctl("status");
		console.log(result.output || `systemctl status exited with ${result.status}`);
		return;
	}

	if (action === "status") {
		console.log("Akasha gateway status");
		console.log(`- configured: ${status.ok}`);
		console.log(`- enabled: ${status.config.enabled}`);
		console.log(`- telegram: ${status.config.telegram.enabled}`);
		console.log(`- mode: ${status.config.telegram.mode}`);
		console.log(`- callback mode: ${status.config.callbackMode}`);
		console.log(`- default cwd: ${status.config.defaultCwd}`);
		console.log(`- allowed users: ${status.config.telegram.allowedUsers.size}`);
		console.log(`- home chat: ${status.config.telegram.homeChatId ?? "(missing)"}`);
		if (status.missing.length > 0) console.log(`- missing: ${status.missing.join(", ")}`);
		if (status.warnings.length > 0) console.log(`- warnings: ${status.warnings.join("; ")}`);
		console.log(chalk.dim(`Secrets file: ${resolveAkashaGatewayEnvPath(agentDir)}`));
		return;
	}

	if (action === "install") {
		if (!args.includes("--user")) {
			console.log("Only user-level systemd install is supported: akasha gateway install --user");
			return;
		}
		const result = installAkashaGatewayUserService({
			agentDir,
			cwd: status.config.defaultCwd,
			dryRun: args.includes("--dry-run"),
		});
		console.log(result.written ? "Akasha gateway user service installed." : "Akasha gateway user service dry run.");
		console.log(`- path: ${result.path}`);
		if (!result.written) console.log(result.content);
		return;
	}

	if (action === "uninstall") {
		if (!args.includes("--user")) {
			console.log("Only user-level systemd uninstall is supported: akasha gateway uninstall --user");
			return;
		}
		console.log(
			uninstallAkashaGatewayUserService() ? "Akasha gateway user service removed." : "No user service found.",
		);
		return;
	}

	if (action === "start" || action === "stop") {
		if (!args.includes("--user")) {
			console.log(`Use akasha gateway ${action} --user for the systemd user service.`);
			return;
		}
		const result = runAkashaGatewaySystemctl(action);
		console.log(result.output || `systemctl ${action} exited with ${result.status}`);
		return;
	}

	if (action === "logs") {
		if (!args.includes("--user")) {
			console.log("Use akasha gateway logs --user for the systemd user service.");
			return;
		}
		const result = readAkashaGatewayJournal();
		console.log(result.output || `journalctl exited with ${result.status}`);
		return;
	}

	if (action !== "run") {
		console.log("Usage: akasha gateway [setup|status|run|install|uninstall|start|stop|logs]");
		return;
	}

	const created = createAkashaGatewayRunnerFromSettings({ agentDir, cwd, settings });
	if (!created.runner) {
		console.log("Akasha gateway is not ready.");
		if (created.status.missing.length > 0) console.log(`Missing: ${created.status.missing.join(", ")}`);
		if (created.status.warnings.length > 0) console.log(`Warnings: ${created.status.warnings.join("; ")}`);
		process.exitCode = 1;
		return;
	}

	console.log("Starting Akasha gateway. Press Ctrl+C to stop.");
	await created.runner.start();
}

async function handleAkashaDaemonCommand(
	args: string[],
	cwd: string,
	agentDir: string,
	settingsManager: SettingsManager,
): Promise<void> {
	const action = args[0] ?? "status";
	const settings = settingsManager.getAkashaSettings();
	const stores = loadStoresForScope(cwd, agentDir, settings.eventLogDir, parseScope(args));
	if (stores.length === 0) {
		console.log("Akasha daemon: no event logs found.");
		return;
	}

	if (action === "status") {
		const queueCount = stores.reduce(
			(total, store) =>
				total +
				buildAkashaDaemonQueue(store.buildTimeline({ limit: 1000 }), {
					reflection: settings.reflection,
				}).length,
			0,
		);
		const runnableCount = stores.reduce(
			(total, store) => total + buildRunnableCallbacks(store.buildTimeline({ limit: 1000 })).length,
			0,
		);
		console.log("Akasha daemon status");
		console.log(`- sessions: ${stores.length}`);
		console.log(`- queue items: ${queueCount}`);
		console.log(`- runnable callbacks: ${runnableCount}`);
		return;
	}

	if (action === "tick") {
		let scheduled = 0;
		let due = 0;
		let queue = 0;
		for (const store of stores) {
			const result = runAkashaDaemonQueuePass(store, { reflection: settings.reflection });
			scheduled += result.scheduledCallbacks.length;
			due += result.dueCallbacks.length;
			queue += result.queue.length;
		}
		console.log("Akasha daemon tick");
		console.log(`- sessions: ${stores.length}`);
		console.log(`- scheduled callbacks: ${scheduled}`);
		console.log(`- due callbacks: ${due}`);
		console.log(`- queue items: ${queue}`);
		return;
	}

	if (action === "run") {
		const dispatchMode = parseDispatchMode(args);
		let claimed = 0;
		let dispatched = 0;
		let failed = 0;
		for (const store of stores) {
			const result = runAkashaCallbackRunner(store, {
				reflection: settings.reflection,
				dispatchMode,
				agentDir,
				rules: rulesForAkashaPolicyProfile(settings.policyProfile),
			});
			claimed += result.claimed.length;
			dispatched += result.dispatched.length;
			failed += result.failed.length;
		}
		console.log("Akasha daemon run");
		console.log(`- sessions: ${stores.length}`);
		console.log(`- dispatch: ${dispatchMode}`);
		console.log(`- claimed: ${claimed}`);
		console.log(`- dispatched: ${dispatched}`);
		console.log(`- failed: ${failed}`);
		return;
	}

	console.log(
		"Usage: akasha daemon status|tick|run [--scope current|project|all] [--dispatch record_only|terminal_notification|agent_prompt_file|auto_run_safe]",
	);
}

function handleAkashaCacheCommand(
	args: string[],
	cwd: string,
	agentDir: string,
	settingsManager: SettingsManager,
): void {
	const action = args[0] ?? "status";
	const settings = settingsManager.getAkashaSettings();
	const stores = loadStoresForScope(cwd, agentDir, settings.eventLogDir, parseScope(args));
	if (stores.length === 0) {
		console.log("Akasha cache: no event logs found.");
		return;
	}

	if (action === "status") {
		const statuses = stores.map((store) =>
			getAkashaProjectionCacheFreshness({
				agentDir,
				eventLogDir: settings.eventLogDir,
				scope: "session",
				cacheKey: sessionStateProjectionCacheKey(store, 1000),
				sourceLogPaths: [store.eventLogPath],
			}),
		);
		console.log("Akasha cache status");
		console.log(`- sessions: ${stores.length}`);
		console.log(`- fresh: ${statuses.filter((item) => item.status === "fresh").length}`);
		console.log(`- stale: ${statuses.filter((item) => item.status === "stale").length}`);
		console.log(`- missing: ${statuses.filter((item) => item.status === "missing").length}`);
		console.log(`- invalid: ${statuses.filter((item) => item.status === "invalid").length}`);
		return;
	}

	if (action === "clear") {
		let cleared = 0;
		for (const store of stores) {
			if (
				clearAkashaProjectionCache({
					agentDir,
					eventLogDir: settings.eventLogDir,
					scope: "session",
					cacheKey: sessionStateProjectionCacheKey(store, 1000),
					sourceLogPaths: [store.eventLogPath],
				})
			) {
				cleared++;
			}
		}
		console.log("Akasha cache clear");
		console.log(`- sessions: ${stores.length}`);
		console.log(`- cleared: ${cleared}`);
		return;
	}

	if (action === "rebuild") {
		for (const store of stores) {
			clearAkashaProjectionCache({
				agentDir,
				eventLogDir: settings.eventLogDir,
				scope: "session",
				cacheKey: sessionStateProjectionCacheKey(store, 1000),
				sourceLogPaths: [store.eventLogPath],
			});
			buildCachedAkashaTemporalStateSnapshot(store, {
				agentDir,
				eventLogDir: settings.eventLogDir,
				limit: 1000,
			});
		}
		console.log("Akasha cache rebuild");
		console.log(`- sessions: ${stores.length}`);
		console.log(`- rebuilt: ${stores.length}`);
		return;
	}

	console.log("Usage: akasha cache status|clear|rebuild [--scope current|project|all]");
}

function handleAkashaInboxCommand(args: string[], agentDir: string, settingsManager: SettingsManager): void {
	const action = args[0] ?? "status";
	const settings = settingsManager.getAkashaSettings();
	const projection = projectAkashaCallbackInbox(agentDir);
	const actionable = listAkashaActionableCallbackPrompts(agentDir);

	if (action === "status") {
		console.log("Akasha inbox status");
		console.log(`- total: ${projection.length}`);
		console.log(`- pending: ${projection.filter((item) => item.status === "pending").length}`);
		console.log(`- injected: ${projection.filter((item) => item.status === "injected").length}`);
		console.log(`- consumed: ${projection.filter((item) => item.status === "consumed").length}`);
		console.log(`- failed: ${projection.filter((item) => item.status === "failed").length}`);
		console.log(`- cancelled: ${projection.filter((item) => item.status === "cancelled").length}`);
		return;
	}

	if (action === "list") {
		console.log("Akasha inbox");
		if (projection.length === 0) {
			console.log("- (empty)");
			return;
		}
		for (const item of projection) {
			console.log(`- ${item.prompt.id} [${item.status}] ${item.prompt.summary}`);
		}
		return;
	}

	if (action === "run") {
		const limit = parseLimit(args, 5);
		const selected = actionable.slice(0, limit);
		console.log("Akasha inbox run");
		if (selected.length === 0) {
			console.log("- no actionable callback prompts");
			return;
		}
		for (const item of selected) {
			const store = storeForInboxItem(item, agentDir, settings.eventLogDir);
			const event = appendAkashaCallbackInboxEvent(store, "callback.inbox.injected", item.prompt, {
				sourceKeySuffix: "cli-run",
			});
			appendAkashaCallbackInboxStatus(agentDir, item.prompt, {
				status: "injected",
				eventId: event.eventId,
				consumerSessionId: item.prompt.sessionId,
			});
			console.log(`\n# ${item.prompt.id}`);
			console.log(item.prompt.prompt);
		}
		return;
	}

	if (action === "consume") {
		const target = args[1] ?? "";
		if (!target) {
			console.log("Usage: akasha inbox consume <id|all>");
			return;
		}
		const selected = target === "all" ? actionable : actionable.filter((item) => item.prompt.id === target);
		let consumed = 0;
		for (const item of selected) {
			const store = storeForInboxItem(item, agentDir, settings.eventLogDir);
			const event = appendAkashaCallbackInboxEvent(store, "callback.inbox.consumed", item.prompt, {
				sourceKeySuffix: "cli-consume",
				reason: "operator_consumed",
			});
			appendAkashaCallbackInboxStatus(agentDir, item.prompt, {
				status: "consumed",
				eventId: event.eventId,
				consumerSessionId: item.prompt.sessionId,
				reason: "operator_consumed",
			});
			consumed++;
		}
		console.log("Akasha inbox consume");
		console.log(`- consumed: ${consumed}`);
		return;
	}

	console.log("Usage: akasha inbox status|list|run|consume [id|all]");
}

function loadStoresForScope(
	cwd: string,
	agentDir: string,
	eventLogDir: string | undefined,
	scope: "current" | "project" | "all",
): AkashaStore[] {
	return buildAkashaSessionIndex({
		agentDir,
		eventLogDir,
		cwd: scope === "all" ? undefined : cwd,
	}).map((entry) => new JsonlAkashaStore(entry.eventLogPath));
}

function parseScope(args: string[]): "current" | "project" | "all" {
	const index = args.indexOf("--scope");
	const value = index >= 0 ? args[index + 1] : undefined;
	if (value === "all" || value === "project" || value === "current") return value;
	return "project";
}

function parseLimit(args: string[], defaultValue: number): number {
	const index = args.indexOf("--limit");
	const value = index >= 0 ? args[index + 1] : undefined;
	const parsed = value ? Number(value) : defaultValue;
	if (!Number.isFinite(parsed)) return defaultValue;
	return Math.max(1, Math.min(50, Math.floor(parsed)));
}

function storeForInboxItem(
	item: AkashaCallbackInboxItem,
	agentDir: string,
	eventLogDir: string | undefined,
): JsonlAkashaStore {
	return new JsonlAkashaStore(resolveAkashaEventLogPath({ eventLogDir }, agentDir, item.prompt.sessionId));
}

function parseDispatchMode(args: string[]): AkashaCallbackDispatchMode {
	const index = args.indexOf("--dispatch");
	const value = index >= 0 ? args[index + 1] : undefined;
	if (
		value === "record_only" ||
		value === "terminal_notification" ||
		value === "agent_prompt_file" ||
		value === "auto_run_safe"
	) {
		return value;
	}
	return "agent_prompt_file";
}

function projectSettingsPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "settings.json");
}

function globalSettingsPath(agentDir: string): string {
	return join(agentDir, "settings.json");
}
