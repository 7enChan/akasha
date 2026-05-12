import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlAkashaStore } from "../src/core/akasha/jsonl-store.js";
import { buildAkashaProjectTimeline } from "../src/core/akasha/project-timeline.js";
import { buildAkashaSessionIndex, loadAkashaProjectTimeline } from "../src/core/akasha/session-index.js";

describe("Akasha session index", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "akasha-session-index-"));
		agentDir = join(tempDir, "agent");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("indexes local event logs and filters by project cwd", () => {
		const projectA = join(tempDir, "project-a");
		const projectB = join(tempDir, "project-b");
		writeSession(agentDir, "session-a", projectA, "message.user.submitted");
		writeSession(agentDir, "session-b", projectB, "message.user.submitted");

		const index = buildAkashaSessionIndex({ agentDir, cwd: projectA });
		const timeline = loadAkashaProjectTimeline({ agentDir, cwd: projectA });

		expect(index.map((entry) => entry.sessionId)).toEqual(["session-a"]);
		expect(timeline.map((event) => event.sessionId)).toEqual(["session-a", "session-a"]);
	});

	it("builds a project timeline and state across matching sessions", () => {
		const projectA = join(tempDir, "project-a");
		writeSession(agentDir, "session-a", projectA, "message.user.submitted");
		const second = new JsonlAkashaStore(join(agentDir, "akasha", "events", "session-c.jsonl"));
		second.append({
			kind: "session.started",
			sessionId: "session-c",
			streamId: "session:session-c",
			eventTime: "2026-05-12T00:00:00.000Z",
			actor: "system",
			payload: { cwd: projectA },
		});
		second.append({
			kind: "artifact.patched",
			sessionId: "session-c",
			streamId: "session:session-c",
			eventTime: "2026-05-12T00:00:01.000Z",
			actor: "tool",
			objectId: "src/app.ts",
			payload: { path: "src/app.ts", isError: false },
		});

		const timeline = buildAkashaProjectTimeline({ agentDir, cwd: projectA });

		expect(timeline.sessions.map((session) => session.sessionId)).toEqual(["session-c", "session-a"]);
		expect(timeline.events.map((event) => event.sessionId)).toEqual([
			"session-a",
			"session-a",
			"session-c",
			"session-c",
		]);
		expect(timeline.state.currentGoal).toBe("hello");
		expect(timeline.state.activeFiles.map((file) => file.path)).toEqual(["src/app.ts"]);
	});
});

function writeSession(agentDir: string, sessionId: string, cwd: string, kind: "message.user.submitted"): void {
	const store = new JsonlAkashaStore(join(agentDir, "akasha", "events", `${sessionId}.jsonl`));
	store.append({
		kind: "session.started",
		sessionId,
		streamId: `session:${sessionId}`,
		eventTime: "2026-05-11T00:00:00.000Z",
		actor: "system",
		payload: { cwd },
	});
	store.append({
		kind,
		sessionId,
		streamId: `session:${sessionId}`,
		eventTime: "2026-05-11T00:00:01.000Z",
		actor: "user",
		payload: { text: "hello" },
	});
}
