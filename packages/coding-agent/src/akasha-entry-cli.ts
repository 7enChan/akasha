import { existsSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { CONFIG_DIR_NAME, getAgentDir, IS_AKASHA_ENTRYPOINT } from "./config.js";
import { SettingsManager } from "./core/settings-manager.js";

export async function handleAkashaEntrypointCommand(
	args: string[],
	cwd: string,
	options: { force?: boolean } = {},
): Promise<boolean> {
	if (!IS_AKASHA_ENTRYPOINT && !options.force) return false;
	const [command] = args;
	if (command !== "init" && command !== "enable" && command !== "status") return false;

	if (args.includes("--help") || args.includes("-h")) {
		printAkashaEntrypointHelp(command);
		return true;
	}

	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const scope = args.includes("--global") ? "global" : "project";

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
	console.log(`- event log dir: ${settings.eventLogDir ?? join(agentDir, "akasha", "events")}`);
	console.log(`- project settings: ${projectPath}${existsSync(projectPath) ? "" : " (missing)"}`);
	console.log(`- global settings: ${globalPath}${existsSync(globalPath) ? "" : " (missing)"}`);
	return true;
}

function printAkashaEntrypointHelp(command?: string): void {
	const usage =
		command === "status"
			? "akasha status"
			: command === "enable"
				? "akasha enable [--global]"
				: "akasha init [--global]";
	console.log(`${chalk.bold("Akasha")} - local-first time layer for coding-agent sessions

${chalk.bold("Usage:")}
  ${usage}

${chalk.bold("Commands:")}
  akasha init [--global]    Write the Akasha dogfood preset
  akasha enable [--global]  Alias for init
  akasha status             Show resolved Akasha state
  akasha                    Start the agent runtime

By default init writes project settings at ${CONFIG_DIR_NAME}/settings.json.
Use --global to write ${CONFIG_DIR_NAME}/agent/settings.json instead.`);
}

function projectSettingsPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "settings.json");
}

function globalSettingsPath(agentDir: string): string {
	return join(agentDir, "settings.json");
}
