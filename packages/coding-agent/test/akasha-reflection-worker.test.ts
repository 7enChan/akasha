import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlAkashaStore } from "../src/core/akasha/jsonl-store.js";
import { createMemoryGovernanceEvent } from "../src/core/akasha/memory-governance.js";
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
		expect(result.crystals[0]?.payload.sourceEventIds).toEqual([expect.any(String), expect.any(String)]);
		expect(result.memoryCrystals.map((event) => event.kind)).toContain("memory.crystal.created");
		expect(result.memoryCrystals[0]?.payload.sourceEventIds).toEqual(result.crystals[0]?.payload.sourceEventIds);
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

	it("does not crystallize suppressed source events", () => {
		const source = store.append({
			kind: "message.user.submitted",
			sessionId: "session-1",
			streamId: "session:session-1",
			eventTime: "2026-05-11T00:00:01.000Z",
			actor: "user",
			payload: { text: "我希望你记住这个临时偏好。" },
		});
		store.append(createMemoryGovernanceEvent(source, "suppress", "temporary"));

		const result = runReflectionPass(store, {
			now: () => "2026-05-11T00:00:03.000Z",
		});

		expect(result.started.payload.governedEventCount).toBe(0);
		expect(result.crystals).toEqual([]);
		expect(result.memoryCrystals).toEqual([]);
		expect(result.completed.payload.crystalCount).toBe(0);
	});
});
