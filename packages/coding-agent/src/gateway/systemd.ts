import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface AkashaGatewaySystemdUnitOptions {
	agentDir: string;
	cwd: string;
	execPath?: string;
	entryPath?: string;
}

export function buildAkashaGatewaySystemdUnit(options: AkashaGatewaySystemdUnitOptions): string {
	const execPath = options.execPath ?? process.execPath;
	const entryPath = options.entryPath ?? process.argv[1] ?? "akasha";
	const execStart = entryPath.endsWith("akasha") ? quote(entryPath) : `${quote(execPath)} ${quote(entryPath)}`;
	return `[Unit]
Description=Akasha Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${options.cwd}
Environment=AKASHA_CODING_AGENT_DIR=${options.agentDir}
ExecStart=${execStart} gateway
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export function resolveAkashaGatewayUserUnitPath(): string {
	return join(homedir(), ".config", "systemd", "user", "akasha-gateway.service");
}

export function installAkashaGatewayUserService(options: AkashaGatewaySystemdUnitOptions & { dryRun?: boolean }): {
	path: string;
	content: string;
	written: boolean;
} {
	const path = resolveAkashaGatewayUserUnitPath();
	const content = buildAkashaGatewaySystemdUnit(options);
	if (!options.dryRun) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content, "utf-8");
	}
	return { path, content, written: !options.dryRun };
}

export function uninstallAkashaGatewayUserService(): boolean {
	const path = resolveAkashaGatewayUserUnitPath();
	if (!existsSync(path)) return false;
	rmSync(path, { force: true });
	return true;
}

export function runAkashaGatewaySystemctl(action: "start" | "stop" | "status"): {
	status: number | null;
	output: string;
} {
	const result = spawnSync("systemctl", ["--user", action, "akasha-gateway"], {
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return {
		status: result.status,
		output: [result.stdout, result.stderr].filter(Boolean).join("\n").trim(),
	};
}

export function readAkashaGatewayJournal(): { status: number | null; output: string } {
	const result = spawnSync("journalctl", ["--user", "-u", "akasha-gateway", "-n", "100", "--no-pager"], {
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return {
		status: result.status,
		output: [result.stdout, result.stderr].filter(Boolean).join("\n").trim(),
	};
}

function quote(value: string): string {
	return value.includes(" ") ? `"${value.replace(/"/g, '\\"')}"` : value;
}
