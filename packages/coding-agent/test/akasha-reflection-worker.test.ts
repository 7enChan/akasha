import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlAkashaStore } from "../src/core/akasha/jsonl-store.js";
import { runReflectionPass } from "../src/core/akasha/reflection-worker.js";

describe("runReflectionPass", () => {
	let tempDir: string;
	let store: JsonlAkashaStore;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "akasha-reflection-"));
		store = new JsonlAkashaStore(join(tempDir, "events.jsonl"));
	});

	afterEach(() => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("records reflection lifecycle and memory crystals", () => {
		store.append({
			kind: "tool.completed",
			sessionId: "session-1",
			streamId: "session:session-1",
			eventTime: "2026-05-11T00:00:01.000Z",
			actor: "tool",
			objectId: "bash",
			payload: { toolName: "bash", isError: true, text: "failed" },
		});
		store.append({
			kind: "tool.completed",
			sessionId: "session-1",
			streamId: "session:session-1",
			eventTime: "2026-05-11T00:00:02.000Z",
			actor: "tool",
			objectId: "bash",
			payload: { toolName: "bash", isError: true, text: "failed again" },
		});

		const result = runReflectionPass(store, {
			now: () => "2026-05-11T00:00:03.000Z",
		});

		expect(result.started.kind).toBe("reflection.started");
		expect(result.crystals.map((event) => event.kind)).toContain("failure.lesson_learned");
		expect(result.memoryCrystals.map((event) => event.kind)).toContain("memory.crystal.created");
		expect(result.completed.payload.crystalCount).toBe(1);
		expect(store.buildTimeline().map((event) => event.kind)).toEqual(
			expect.arrayContaining([
				"reflection.started",
				"failure.lesson_learned",
				"memory.crystal.created",
				"reflection.completed",
			]),
		);
	});
});
