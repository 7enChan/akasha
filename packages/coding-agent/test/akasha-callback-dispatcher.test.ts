import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendAkashaCallbackInboxStatus,
	listAkashaActionableCallbackPrompts,
	listAkashaPendingCallbackPrompts,
	projectAkashaCallbackInbox,
	resolveAkashaCallbackInboxPath,
} from "../src/core/akasha/callback-inbox.js";
import { runAkashaCallbackRunner } from "../src/core/akasha/callback-runner.js";
import { JsonlAkashaStore } from "../src/core/akasha/jsonl-store.js";

describe("Akasha callback dispatchers", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "akasha-callback-dispatcher-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("dispatches callbacks into an agent prompt inbox file", () => {
		const store = new JsonlAkashaStore(join(tempDir, "events.jsonl"));
		appendDueCallback(store);

		const result = runAkashaCallbackRunner(store, {
			reflection: reflectionOff(),
			dispatchMode: "agent_prompt_file",
			agentDir: tempDir,
			now: new Date("2026-05-12T00:01:00.000Z"),
		});
		const prompts = listAkashaPendingCallbackPrompts(tempDir);

		expect(result.dispatched).toHaveLength(1);
		expect(result.dispatched[0]?.payload).toMatchObject({
			dispatchMode: "agent_prompt_file",
			dispatchDetails: {
				inboxItemId: expect.stringContaining("callback-1"),
				inboxEventId: expect.any(String),
			},
			outputEventIds: [expect.any(String)],
		});
		expect(store.buildTimeline({ limit: 20 }).map((event) => event.kind)).toContain("callback.inbox.added");
		expect(existsSync(resolveAkashaCallbackInboxPath(tempDir))).toBe(true);
		expect(prompts).toMatchObject([
			{
				callbackId: "callback-1",
				summary: "Follow up outside the session",
				status: "pending",
			},
		]);
		expect(prompts[0]?.prompt).toContain("Continue this temporal responsibility");
	});

	it("projects append-only inbox status records", () => {
		const store = new JsonlAkashaStore(join(tempDir, "events.jsonl"));
		appendDueCallback(store);
		runAkashaCallbackRunner(store, {
			reflection: reflectionOff(),
			dispatchMode: "agent_prompt_file",
			agentDir: tempDir,
			now: new Date("2026-05-12T00:01:00.000Z"),
		});
		const [prompt] = listAkashaPendingCallbackPrompts(tempDir);
		expect(prompt).toBeDefined();

		appendAkashaCallbackInboxStatus(tempDir, prompt!, {
			status: "injected",
			eventTime: "2026-05-12T00:02:00.000Z",
			eventId: "injected-1",
		});

		expect(listAkashaPendingCallbackPrompts(tempDir)).toHaveLength(0);
		expect(listAkashaActionableCallbackPrompts(tempDir)).toHaveLength(1);
		expect(projectAkashaCallbackInbox(tempDir)[0]).toMatchObject({
			status: "injected",
			lastStatusRecord: {
				eventId: "injected-1",
			},
		});
	});

	it("fails agent prompt dispatch without an agentDir", () => {
		const store = new JsonlAkashaStore(join(tempDir, "events.jsonl"));
		appendDueCallback(store);

		const result = runAkashaCallbackRunner(store, {
			reflection: reflectionOff(),
			dispatchMode: "agent_prompt_file",
			now: new Date("2026-05-12T00:01:00.000Z"),
		});

		expect(result.failed).toHaveLength(1);
		expect(result.failed[0]?.payload).toMatchObject({
			dispatchMode: "agent_prompt_file",
			reason: "agent_prompt_file dispatch requires agentDir",
		});
	});
});

function appendDueCallback(store: JsonlAkashaStore): void {
	store.append({
		kind: "time.callback.due",
		sessionId: "session-1",
		streamId: "session:session-1",
		eventTime: "2026-05-12T00:00:00.000Z",
		actor: "system",
		payload: {
			callbackId: "callback-1",
			kind: "scheduled_callback",
			dueTime: "2026-05-12T00:00:00.000Z",
			summary: "Follow up outside the session",
		},
		ttlPolicy: "long_term",
	});
}

function reflectionOff() {
	return {
		enabled: false,
		minEventsSinceLastReflection: 40,
		minIntervalMinutes: 240,
	};
}
