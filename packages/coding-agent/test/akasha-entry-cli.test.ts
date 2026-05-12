import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleAkashaEntrypointCommand } from "../src/akasha-entry-cli.js";
import { JsonlAkashaStore } from "../src/core/akasha/jsonl-store.js";

describe("Akasha entry CLI", () => {
	let tempDir: string;
	let projectDir: string;
	let previousAgentDir: string | undefined;
	let logs: string[];

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "akasha-entry-cli-"));
		projectDir = join(tempDir, "project");
		previousAgentDir = process.env.AKASHA_CODING_AGENT_DIR;
		process.env.AKASHA_CODING_AGENT_DIR = join(tempDir, "agent");
		logs = [];
		vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
			logs.push(String(message ?? ""));
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (previousAgentDir === undefined) {
			delete process.env.AKASHA_CODING_AGENT_DIR;
		} else {
			process.env.AKASHA_CODING_AGENT_DIR = previousAgentDir;
		}
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("writes the Akasha preset to project settings by default", async () => {
		const handled = await handleAkashaEntrypointCommand(["init"], projectDir);
		const settings = JSON.parse(readFileSync(join(projectDir, ".akasha", "settings.json"), "utf-8"));

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
		const handled = await handleAkashaEntrypointCommand(["enable", "--global"], projectDir);
		const settings = JSON.parse(readFileSync(join(process.env.AKASHA_CODING_AGENT_DIR!, "settings.json"), "utf-8"));

		expect(handled).toBe(true);
		expect(settings.akasha).toMatchObject({ enabled: true });
		expect(logs.join("\n")).toContain("global settings");
	});

	it("prints resolved Akasha status", async () => {
		await handleAkashaEntrypointCommand(["init"], projectDir);
		logs = [];

		const handled = await handleAkashaEntrypointCommand(["status"], projectDir);

		expect(handled).toBe(true);
		expect(logs.join("\n")).toContain("Akasha status");
		expect(logs.join("\n")).toContain("- enabled: true");
	});

	it("runs daemon callbacks outside an interactive session", async () => {
		await handleAkashaEntrypointCommand(["init"], projectDir);
		const store = seedAkashaLog(projectDir);
		store.append({
			kind: "time.callback.due",
			sessionId: "session-1",
			streamId: "session:session-1",
			eventTime: "2026-05-12T00:00:00.000Z",
			actor: "system",
			payload: {
				callbackId: "callback-entry",
				kind: "scheduled_callback",
				summary: "Resume from CLI daemon",
			},
			ttlPolicy: "long_term",
		});
		logs = [];

		const handled = await handleAkashaEntrypointCommand(
			["daemon", "run", "--scope", "project", "--dispatch", "agent_prompt_file"],
			projectDir,
		);

		expect(handled).toBe(true);
		expect(logs.join("\n")).toContain("Akasha daemon run");
		expect(logs.join("\n")).toContain("- dispatched: 1");
		expect(
			readFileSync(
				join(process.env.AKASHA_CODING_AGENT_DIR!, "akasha", "inbox", "pending-callbacks.jsonl"),
				"utf-8",
			),
		).toContain("Resume from CLI daemon");
	});

	it("rebuilds projection caches outside an interactive session", async () => {
		await handleAkashaEntrypointCommand(["init"], projectDir);
		seedAkashaLog(projectDir);
		logs = [];

		const handled = await handleAkashaEntrypointCommand(["cache", "rebuild", "--scope", "project"], projectDir);

		expect(handled).toBe(true);
		expect(logs.join("\n")).toContain("Akasha cache rebuild");
		expect(logs.join("\n")).toContain("- rebuilt: 1");
	});
});

function seedAkashaLog(projectDir: string): JsonlAkashaStore {
	const store = new JsonlAkashaStore(
		join(process.env.AKASHA_CODING_AGENT_DIR!, "akasha", "events", "session-1.jsonl"),
	);
	store.append({
		kind: "session.started",
		sessionId: "session-1",
		streamId: "session:session-1",
		eventTime: "2026-05-12T00:00:00.000Z",
		actor: "system",
		payload: { cwd: projectDir },
	});
	return store;
}
