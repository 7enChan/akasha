import { describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";
import { resolveAkashaGatewayConfig } from "../src/gateway/config.js";
import { parseDotEnv } from "../src/gateway/env.js";
import { AkashaGatewayQueue } from "../src/gateway/queue.js";
import { buildAkashaGatewaySystemdUnit } from "../src/gateway/systemd.js";

describe("Akasha gateway core", () => {
	it("parses .env values without overriding process env precedence", () => {
		expect(parseDotEnv('TELEGRAM_BOT_TOKEN="abc"\n# comment\nTELEGRAM_ALLOWED_USERS=1,2\nBAD-KEY=no')).toEqual({
			TELEGRAM_BOT_TOKEN: "abc",
			TELEGRAM_ALLOWED_USERS: "1,2",
		});
	});

	it("resolves Telegram gateway config and reports missing secrets", () => {
		const manager = SettingsManager.inMemory({
			akasha: {
				gateway: {
					enabled: true,
					defaultCwd: "/tmp/project",
					callbackMode: "ask_before_run",
					platforms: { telegram: { enabled: true, mode: "polling" } },
				},
			},
		});

		const missing = resolveAkashaGatewayConfig({
			agentDir: "/tmp/agent",
			cwd: "/tmp/other",
			settings: manager.getAkashaSettings(),
			env: {},
		});
		const ready = resolveAkashaGatewayConfig({
			agentDir: "/tmp/agent",
			cwd: "/tmp/other",
			settings: manager.getAkashaSettings(),
			env: {
				TELEGRAM_BOT_TOKEN: "secret",
				TELEGRAM_ALLOWED_USERS: "123,456",
				TELEGRAM_HOME_CHAT: "123",
			},
		});

		expect(missing.ok).toBe(false);
		expect(missing.missing).toContain("TELEGRAM_BOT_TOKEN");
		expect(missing.missing).toContain("TELEGRAM_ALLOWED_USERS");
		expect(ready.ok).toBe(true);
		expect(ready.config.defaultCwd).toBe("/tmp/project");
		expect(ready.config.callbackMode).toBe("ask_before_run");
		expect([...ready.config.telegram.allowedUsers]).toEqual([123, 456]);
		expect(ready.config.telegram.homeChatId).toBe(123);
	});

	it("serializes tasks per chat while allowing other chats to run", async () => {
		const queue = new AkashaGatewayQueue();
		const events: string[] = [];
		const first = queue.enqueue("a", async () => {
			events.push("a1:start");
			await Promise.resolve();
			events.push("a1:end");
		});
		const second = queue.enqueue("a", async () => {
			events.push("a2");
		});
		const third = queue.enqueue("b", async () => {
			events.push("b1");
		});

		await Promise.all([first, second, third]);

		expect(events.indexOf("a1:end")).toBeLessThan(events.indexOf("a2"));
		expect(events).toContain("b1");
		expect(queue.pendingKeys()).toEqual([]);
	});

	it("builds a user-level systemd unit for the gateway", () => {
		const unit = buildAkashaGatewaySystemdUnit({
			agentDir: "/home/me/.akasha/agent",
			cwd: "/srv/akasha",
			execPath: "/usr/bin/node",
			entryPath: "/usr/bin/akasha",
		});

		expect(unit).toContain("Description=Akasha Gateway");
		expect(unit).toContain("WorkingDirectory=/srv/akasha");
		expect(unit).toContain("Environment=AKASHA_CODING_AGENT_DIR=/home/me/.akasha/agent");
		expect(unit).toContain("ExecStart=/usr/bin/akasha gateway");
		expect(unit).toContain("Restart=always");
	});
});
