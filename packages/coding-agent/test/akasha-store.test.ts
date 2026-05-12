import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlAkashaStore } from "../src/core/akasha/jsonl-store.js";
import type { AkashaEventDraft } from "../src/core/akasha/types.js";

describe("JsonlAkashaStore", () => {
	let tempDir: string;
	let logPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "akasha-store-"));
		logPath = join(tempDir, "events", "session.jsonl");
	});

	afterEach(() => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function draft(overrides: Partial<AkashaEventDraft> = {}): AkashaEventDraft {
		return {
			kind: "session.started",
			sessionId: "session-1",
			streamId: "session:session-1",
			eventTime: "2026-05-11T00:00:00.000Z",
			actor: "system",
			payload: {},
			...overrides,
		};
	}

	it("appends in sequence order and rebuilds from JSONL", () => {
		const store = new JsonlAkashaStore(logPath);
		const first = store.append(draft({ sourceKey: "first" }));
		const second = store.append(draft({ kind: "turn.started", sourceKey: "second" }));

		expect(first.sequence).toBe(1);
		expect(second.sequence).toBe(2);
		expect(store.buildTimeline().map((event) => event.eventId)).toEqual([first.eventId, second.eventId]);

		const reloaded = new JsonlAkashaStore(logPath);
		expect(reloaded.buildTimeline().map((event) => event.eventId)).toEqual([first.eventId, second.eventId]);
	});

	it("deduplicates appends by sourceKey", () => {
		const store = new JsonlAkashaStore(logPath);
		const first = store.append(draft({ sourceKey: "same-source" }));
		const duplicate = store.append(draft({ kind: "turn.started", sourceKey: "same-source" }));

		expect(duplicate.eventId).toBe(first.eventId);
		expect(store.listRecent({ limit: 10 })).toHaveLength(1);
	});

	it("deduplicates sourceKey across store instances by reloading under lock", () => {
		const firstStore = new JsonlAkashaStore(logPath);
		const secondStore = new JsonlAkashaStore(logPath);
		const first = firstStore.append(draft({ sourceKey: "cross-process-source" }));
		const duplicate = secondStore.append(draft({ kind: "turn.started", sourceKey: "cross-process-source" }));

		expect(duplicate.eventId).toBe(first.eventId);
		expect(new JsonlAkashaStore(logPath).listRecent({ limit: 10 })).toHaveLength(1);
	});

	it("rejects invalid new events during strict append validation", () => {
		const store = new JsonlAkashaStore(logPath);

		expect(() =>
			store.append(
				draft({
					kind: "not.real" as AkashaEventDraft["kind"],
					sourceKey: "bad-kind",
				}),
			),
		).toThrow("Unknown Akasha event kind");
	});

	it("traverses causal chains from root to target", () => {
		const store = new JsonlAkashaStore(logPath);
		const root = store.append(draft({ kind: "message.user.submitted", actor: "user" }));
		const child = store.append(
			draft({
				kind: "message.agent.completed",
				actor: "agent",
				parentEventIds: [root.eventId],
			}),
		);
		const tool = store.append(
			draft({
				kind: "tool.completed",
				actor: "tool",
				toolCallId: "call-1",
				parentEventIds: [child.eventId],
			}),
		);
		const artifact = store.append(
			draft({
				kind: "artifact.read",
				actor: "tool",
				toolCallId: "call-1",
				objectId: "src/app.ts",
				parentEventIds: [tool.eventId],
			}),
		);

		expect(store.explainChain(tool.eventId).map((event) => event.eventId)).toEqual([
			root.eventId,
			child.eventId,
			tool.eventId,
		]);
		expect(store.explainChain("call-1").map((event) => event.eventId)).toEqual([
			root.eventId,
			child.eventId,
			tool.eventId,
			artifact.eventId,
		]);
	});
});
