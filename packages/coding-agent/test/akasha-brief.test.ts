import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTemporalBrief } from "../src/core/akasha/brief.js";
import { JsonlAkashaStore } from "../src/core/akasha/jsonl-store.js";
import type { AkashaEventDraft } from "../src/core/akasha/types.js";

describe("buildTemporalBrief", () => {
	let tempDir: string;
	let store: JsonlAkashaStore;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "akasha-brief-"));
		store = new JsonlAkashaStore(join(tempDir, "session.jsonl"));
	});

	afterEach(() => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function append(overrides: Partial<AkashaEventDraft>): void {
		store.append({
			kind: "session.started",
			sessionId: "session-1",
			streamId: "session:session-1",
			eventTime: "2026-05-11T00:00:00.000Z",
			actor: "system",
			payload: {},
			...overrides,
		});
	}

	it("surfaces failed tools and modified artifacts", () => {
		append({
			kind: "message.user.submitted",
			actor: "user",
			payload: { text: "Fix the failing build" },
			importance: 0.8,
		});
		append({
			kind: "artifact.patched",
			actor: "tool",
			objectId: "src/app.ts",
			payload: { path: "src/app.ts", editCount: 1 },
			importance: 0.9,
		});
		append({
			kind: "tool.completed",
			actor: "tool",
			toolCallId: "call-1",
			objectId: "bash",
			payload: { toolName: "bash", isError: true, text: "Command failed" },
			importance: 0.95,
		});

		const brief = buildTemporalBrief(store, { maxEvents: 5 });

		expect(brief?.text).toContain("Recent failed tools");
		expect(brief?.text).toContain("src/app.ts");
		expect(brief?.text).toContain("Fix the failing build");
		expect(brief?.events.map((event) => event.kind)).not.toContain("message.custom.recorded");
	});
});
