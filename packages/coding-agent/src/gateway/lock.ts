import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export class AkashaGatewayLock {
	private fd: number | undefined;

	constructor(readonly path: string) {}

	acquire(): void {
		mkdirSync(dirname(this.path), { recursive: true });
		if (existsSync(this.path) && this.isStale()) {
			rmSync(this.path, { force: true });
		}
		try {
			this.fd = openSync(this.path, "wx");
			writeFileSync(this.fd, `${process.pid}\n${new Date().toISOString()}\n`, "utf-8");
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(`Akasha gateway is already running or lock cannot be acquired: ${this.path} (${detail})`);
		}
	}

	release(): void {
		if (this.fd !== undefined) {
			closeSync(this.fd);
			this.fd = undefined;
		}
		rmSync(this.path, { force: true });
	}

	private isStale(): boolean {
		try {
			const pid = Number(readFileSync(this.path, "utf-8").split(/\r?\n/)[0]);
			if (!Number.isSafeInteger(pid) || pid <= 0) return true;
			process.kill(pid, 0);
			return false;
		} catch {
			return true;
		}
	}
}

export function resolveAkashaGatewayLockPath(agentDir: string): string {
	return join(agentDir, "gateway", "akasha-gateway.lock");
}
