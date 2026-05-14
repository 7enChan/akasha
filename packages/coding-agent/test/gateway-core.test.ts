import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";
import { resolveAkashaGatewayConfig } from "../src/gateway/config.js";
import { parseDotEnv } from "../src/gateway/env.js";
import { AkashaGatewayInboxStore } from "../src/gateway/inbox-store.js";
import { AkashaGatewayLock } from "../src/gateway/lock.js";
import { AkashaGatewayOutboxStore } from "../src/gateway/outbox-store.js";
import { AkashaGatewayQueue } from "../src/gateway/queue.js";
import {
	readAkashaGatewayRuntimeStatus,
	resolveAkashaGatewayRuntimeStatusPath,
	writeAkashaGatewayRuntimeStatus,
} from "../src/gateway/runtime-status.js";
import { buildAkashaGatewaySystemdUnit } from "../src/gateway/systemd.js";
import type { AkashaGatewayChatState, AkashaGatewayIncomingMessage } from "../src/gateway/types.js";

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

	it("projects inbox JSONL with messageKey dedupe", () => {
		withTempDir((agentDir) => {
			const store = new AkashaGatewayInboxStore(agentDir);
			const chat = gatewayChat(agentDir);
			const message = gatewayMessage();
			const first = store.enqueue({ chat, message, messageKey: "telegram:1:42" });
			const second = store.enqueue({ chat, message, messageKey: "telegram:1:42" });

			expect(first.enqueued).toBe(true);
			expect(second.enqueued).toBe(false);
			expect(store.project().size).toBe(1);
			expect(store.project().get("telegram:1:42")?.state).toBe("queued");
		});
	});

	it("retries expired running inbox leases until attempt three, then dead-letters", () => {
		withTempDir((agentDir) => {
			const store = new AkashaGatewayInboxStore(agentDir);
			store.enqueue({ chat: gatewayChat(agentDir), message: gatewayMessage(), messageKey: "telegram:1:43" });

			store.markRunning("telegram:1:43", new Date("2026-05-12T00:00:00.000Z"), 1000);
			expect(store.listRunnable(new Date("2026-05-12T00:00:01.001Z")).map((record) => record.messageKey)).toEqual([
				"telegram:1:43",
			]);

			store.markRunning("telegram:1:43", new Date("2026-05-12T00:00:02.000Z"), 1000);
			store.markRunning("telegram:1:43", new Date("2026-05-12T00:00:04.000Z"), 1000);
			expect(store.listRunnable(new Date("2026-05-12T00:00:05.001Z"))).toEqual([]);
			const [candidate] = store.listDeadLetterCandidates(new Date("2026-05-12T00:00:05.001Z"));
			expect(candidate?.attempt).toBe(3);
			store.markDeadLetter("telegram:1:43", "retry limit");
			expect(store.project().get("telegram:1:43")?.state).toBe("dead_letter");
		});
	});

	it("schedules outbox retries from Telegram retry_after", () => {
		withTempDir((agentDir) => {
			const store = new AkashaGatewayOutboxStore(agentDir);
			const now = new Date("2026-05-12T00:00:00.000Z");
			const queued = store.enqueueText({
				target: { platform: "telegram", chatId: "1" },
				text: "hello",
				outboxId: "outbox-1",
			});
			store.markSending(queued.record.outboxId, now);
			const failed = store.markFailed(queued.record.outboxId, "rate limited", 7, now);

			expect(failed.state).toBe("failed");
			expect(failed.nextAttemptAt).toBe("2026-05-12T00:00:07.000Z");
			expect(store.listDue(new Date("2026-05-12T00:00:06.999Z"))).toEqual([]);
			expect(store.listDue(new Date("2026-05-12T00:00:07.000Z")).map((record) => record.outboxId)).toEqual([
				"outbox-1",
			]);
		});
	});

	it("writes runtime status atomically and tolerates missing or corrupt files", () => {
		withTempDir((agentDir) => {
			expect(readAkashaGatewayRuntimeStatus(agentDir)).toBeUndefined();
			writeAkashaGatewayRuntimeStatus(agentDir, {
				pid: 123,
				startedAt: "2026-05-12T00:00:00.000Z",
				updatedAt: "2026-05-12T00:00:01.000Z",
				gatewayState: "running",
				platformState: "polling",
				mode: "polling",
				activeChats: ["1"],
				pendingInbox: 1,
				pendingOutbox: 2,
				deadLetters: 0,
				lastUpdateId: 42,
			});
			expect(readAkashaGatewayRuntimeStatus(agentDir)?.pendingOutbox).toBe(2);
			writeFileSync(resolveAkashaGatewayRuntimeStatusPath(agentDir), "{bad", "utf-8");
			expect(readAkashaGatewayRuntimeStatus(agentDir)).toBeUndefined();
		});
	});

	it("prevents acquiring the same Telegram token scoped lock twice", () => {
		withTempDir((agentDir) => {
			const lockDir = join(agentDir, "locks");
			const first = new AkashaGatewayLock(join(agentDir, "first.lock"), {
				telegramBotToken: "token",
				lockDir,
			});
			const second = new AkashaGatewayLock(join(agentDir, "second.lock"), {
				telegramBotToken: "token",
				lockDir,
			});
			try {
				first.acquire();
				expect(() => second.acquire()).toThrow(/lock cannot be acquired|already running/);
			} finally {
				first.release();
				second.release();
			}
			expect(existsSync(lockDir)).toBe(true);
		});
	});
});

function withTempDir(run: (agentDir: string) => void): void {
	const agentDir = mkdtempSync(join(tmpdir(), "akasha-gateway-core-"));
	try {
		run(agentDir);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
}

function gatewayChat(agentDir: string): AkashaGatewayChatState {
	return {
		platform: "telegram",
		chatId: "1",
		cwd: agentDir,
		sessionDir: join(agentDir, "sessions"),
		updatedAt: "2026-05-12T00:00:00.000Z",
	};
}

function gatewayMessage(): AkashaGatewayIncomingMessage {
	return {
		platform: "telegram",
		chatId: "1",
		messageId: "42",
		userId: 123,
		text: "hello",
		receivedTime: "2026-05-12T00:00:00.000Z",
	};
}
