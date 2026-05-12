import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleAkashaEntrypointCommand } from "../src/akasha-entry-cli.js";

describe("Akasha entry CLI", () => {
	let tempDir: string;
	let projectDir: string;
	let previousAgentDir: string | undefined;
	let logs: string[];

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "akasha-entry-cli-"));
		projectDir = join(tempDir, "project");
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = join(tempDir, "agent");
		logs = [];
		vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
			logs.push(String(message ?? ""));
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (previousAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("writes the Akasha preset to project settings by default", async () => {
		const handled = await handleAkashaEntrypointCommand(["init"], projectDir, { force: true });
		const settings = JSON.parse(readFileSync(join(projectDir, ".pi", "settings.json"), "utf-8"));

		expect(handled).toBe(true);
		expect(settings.akasha).toMatchObject({
			enabled: true,
			injectTemporalBrief: true,
			actionGate: {
				enabled: true,
				enforceToolGate: true,
			},
			maintenance: {
				enabled: true,
				heartbeatEnabled: true,
			},
		});
		expect(logs.join("\n")).toContain("Akasha initialized");
	});

	it("writes the Akasha preset to global settings with --global", async () => {
		const handled = await handleAkashaEntrypointCommand(["enable", "--global"], projectDir, { force: true });
		const settings = JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR!, "settings.json"), "utf-8"));

		expect(handled).toBe(true);
		expect(settings.akasha).toMatchObject({ enabled: true });
		expect(logs.join("\n")).toContain("global settings");
	});

	it("prints resolved Akasha status", async () => {
		await handleAkashaEntrypointCommand(["init"], projectDir, { force: true });
		logs = [];

		const handled = await handleAkashaEntrypointCommand(["status"], projectDir, { force: true });

		expect(handled).toBe(true);
		expect(logs.join("\n")).toContain("Akasha status");
		expect(logs.join("\n")).toContain("- enabled: true");
	});
});
