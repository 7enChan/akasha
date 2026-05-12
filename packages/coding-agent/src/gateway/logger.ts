import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export type AkashaGatewayLogLevel = "info" | "warn" | "error";

export class AkashaGatewayLogger {
	readonly logPath: string;

	constructor(
		agentDir: string,
		private readonly quiet = false,
	) {
		this.logPath = join(agentDir, "gateway", "logs", "gateway.log");
		mkdirSync(dirname(this.logPath), { recursive: true });
	}

	info(message: string): void {
		this.write("info", message);
	}

	warn(message: string): void {
		this.write("warn", message);
	}

	error(message: string): void {
		this.write("error", message);
	}

	private write(level: AkashaGatewayLogLevel, message: string): void {
		const line = `${new Date().toISOString()} [${level}] ${message}`;
		appendFileSync(this.logPath, `${line}\n`, "utf-8");
		if (!this.quiet) {
			const sink = level === "error" ? console.error : console.log;
			sink(line);
		}
	}
}
