import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlAkashaStore } from "../src/core/akasha/jsonl-store.js";
import { runAkashaDetachedMaintenance } from "../src/core/akasha/maintenance-runner.js";

describe("Akasha detached maintenance runner", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "akasha-maintenance-runner-"));
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("runs maintenance across project-scoped session logs without an active session turn", async () => {
		const eventLogPath = join(agentDir, "akasha", "events", "session-1.jsonl");
		const store = new JsonlAkashaStore(eventLogPath);
		store.append({
			kind: "session.started",
			sessionId: "session-1",
			streamId: "session:session-1",
			eventTime: "2026-05-12T00:00:00.000Z",
			actor: "system",
			payload: { cwd },
		});
		store.append({
			kind: "artifact.patched",
			sessionId: "session-1",
			streamId: "session:session-1",
			eventTime: "2026-05-12T00:01:00.000Z",
			actor: "tool",
			objectId: "src/app.ts",
			payload: { path: "src/app.ts", isError: false },
			ttlPolicy: "long_term",
		});

		const result = await runAkashaDetachedMaintenance({
			agentDir,
			cwd,
			scope: "project",
			reflection: {
				enabled: false,
				minEventsSinceLastReflection: 40,
				minIntervalMinutes: 240,
			},
			now: new Date("2026-05-12T00:02:00.000Z"),
		});

		expect(result).toMatchObject({
			scope: "project",
			scannedCount: 1,
			maintainedCount: 1,
			errors: [],
		});
		expect(result.appendedCount).toBeGreaterThan(0);
		expect(new JsonlAkashaStore(eventLogPath).buildTimeline({ limit: 20 }).map((event) => event.kind)).toContain(
			"loop.opened",
		);
	});
});
