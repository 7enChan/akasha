/**
 * Bash Spawn Hook Example
 *
 * Adjusts command, cwd, and env before execution.
 *
 * Usage:
 *   akasha -e ./bash-spawn-hook.ts
 */

import type { ExtensionAPI } from "@earendil-works/akasha-coding-agent";
import { createBashTool } from "@earendil-works/akasha-coding-agent";

export default function (akasha: ExtensionAPI) {
	const cwd = process.cwd();

	const bashTool = createBashTool(cwd, {
		spawnHook: ({ command, cwd, env }) => ({
			command: `source ~/.profile\n${command}`,
			cwd,
			env: { ...env, AKASHA_SPAWN_HOOK: "1" },
		}),
	});

	akasha.registerTool({
		...bashTool,
		execute: async (id, params, signal, onUpdate, _ctx) => {
			return bashTool.execute(id, params, signal, onUpdate);
		},
	});
}
