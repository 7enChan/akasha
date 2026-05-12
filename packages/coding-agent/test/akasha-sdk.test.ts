import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlAkashaStore } from "../src/core/akasha/jsonl-store.js";
import { createGenericRuntimeAdapter } from "../src/core/akasha/runtime-adapter.js";
import { createAkashaClient } from "../src/core/akasha/sdk.js";

describe("Akasha SDK", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "akasha-sdk-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("records runtime events through an adapter and exposes projections", () => {
		const store = new JsonlAkashaStore(join(tempDir, "events.jsonl"));
		const client = createAkashaClient({
			store,
			adapter: createGenericRuntimeAdapter({ name: "test-runtime" }),
		});

		client.recordRuntime({
			type: "message.user.submitted",
			sessionId: "session-1",
			eventTime: "2026-05-11T00:00:00.000Z",
			actor: "user",
			payload: { text: "Patch src/app.ts" },
		});
		client.record({
			kind: "artifact.patched",
			sessionId: "session-1",
			streamId: "session:session-1",
			eventTime: "2026-05-11T00:00:01.000Z",
			actor: "tool",
			objectId: "src/app.ts",
			payload: { path: "src/app.ts" },
		});

		expect(client.timeline().map((event) => event.kind)).toEqual(["message.user.submitted", "artifact.patched"]);
		expect(client.worldModel().projectState.currentGoal).toBe("Patch src/app.ts");
		expect(client.karma().promises).toEqual([]);
	});

	it("ignores unknown runtime event types unless they are mapped", () => {
		const store = new JsonlAkashaStore(join(tempDir, "events.jsonl"));
		const client = createAkashaClient({
			store,
			adapter: createGenericRuntimeAdapter({
				kindMap: {
					customUser: "message.user.submitted",
				},
			}),
		});

		expect(client.recordRuntime({ type: "unknown", sessionId: "session-1" })).toBeUndefined();
		expect(
			client.recordRuntime({
				type: "customUser",
				sessionId: "session-1",
				payload: { text: "hello" },
			})?.kind,
		).toBe("message.user.submitted");
	});
});
