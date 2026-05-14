import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import * as lockfile from "proper-lockfile";

export interface AkashaGatewayLockOptions {
	telegramBotToken?: string;
	lockDir?: string;
}

export class AkashaGatewayLock {
	private readonly releases: Array<() => void> = [];

	constructor(
		readonly path: string,
		private readonly options: AkashaGatewayLockOptions = {},
	) {}

	acquire(): void {
		if (this.releases.length > 0) return;
		const targets = [this.path];
		if (this.options.telegramBotToken) {
			targets.push(resolveAkashaGatewayTelegramTokenLockPath(this.options.telegramBotToken, this.options.lockDir));
		}
		try {
			for (const target of targets) {
				this.ensureLockTarget(target);
				const release = lockfile.lockSync(target, {
					realpath: false,
					stale: 30_000,
					update: 10_000,
					retries: 0,
				});
				this.releases.push(release);
				writeFileSync(target, `${process.pid}\n${new Date().toISOString()}\n`, "utf-8");
			}
		} catch (error) {
			this.release();
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(`Akasha gateway is already running or lock cannot be acquired: ${this.path} (${detail})`);
		}
	}

	release(): void {
		while (this.releases.length > 0) {
			const release = this.releases.pop();
			try {
				release?.();
			} catch {
				// Best-effort release during process shutdown.
			}
		}
	}

	private ensureLockTarget(target: string): void {
		mkdirSync(dirname(target), { recursive: true });
		if (!existsSync(target)) {
			writeFileSync(target, `${process.pid}\n${new Date().toISOString()}\n`, "utf-8");
		}
	}
}

export function resolveAkashaGatewayLockPath(agentDir: string): string {
	return join(agentDir, "gateway", "akasha-gateway.lock");
}

export function resolveAkashaGatewayTelegramTokenLockPath(
	token: string,
	lockDir = resolveAkashaGatewayScopedLockDir(),
): string {
	const hash = createHash("sha256").update(token).digest("hex");
	return join(lockDir, `telegram-${hash}.lock`);
}

export function resolveAkashaGatewayScopedLockDir(): string {
	return process.env.AKASHA_GATEWAY_LOCK_DIR || join(homedir(), ".akasha", "gateway-locks");
}
