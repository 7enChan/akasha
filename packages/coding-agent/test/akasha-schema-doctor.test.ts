import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAkashaDoctorReport } from "../src/core/akasha/doctor.js";
import { JsonlAkashaStore } from "../src/core/akasha/jsonl-store.js";
import { parseAkashaJsonl } from "../src/core/akasha/schema.js";

describe("Akasha schema and doctor", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "akasha-schema-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("parses valid JSONL lines and reports invalid lines", () => {
		const parsed = parseAkashaJsonl(
			[
				JSON.stringify({
					eventId: "evt-1",
					kind: "message.user.submitted",
					sessionId: "session-1",
					streamId: "session:session-1",
					sequence: 1,
					eventTime: "2026-05-11T00:00:00.000Z",
					recordedTime: "2026-05-11T00:00:00.000Z",
					actor: "user",
					parentEventIds: [],
					payload: { text: "hello" },
					version: 1,
				}),
				"{broken",
				JSON.stringify({ eventId: "bad" }),
			].join("\n"),
		);

		expect(parsed.events.map((event) => event.eventId)).toEqual(["evt-1"]);
		expect(parsed.events[0]?.importance).toBe(0.5);
		expect(parsed.events[0]?.ttlPolicy).toBe("session");
		expect(parsed.issues.map((issue) => issue.code)).toEqual(["invalid_json", "invalid_shape"]);
	});

	it("surfaces store schema issues through doctor", () => {
		const logPath = join(tempDir, "events.jsonl");
		writeFileSync(logPath, "{broken\n", "utf-8");
		const store = new JsonlAkashaStore(logPath);

		store.append({
			kind: "message.user.submitted",
			sessionId: "session-1",
			streamId: "session:session-1",
			eventTime: "2026-05-11T00:00:00.000Z",
			actor: "user",
			payload: { text: "hello" },
		});

		expect(buildAkashaDoctorReport(store)).toMatchObject({
			eventCount: 1,
			schemaIssueCount: 1,
			redactionCount: 0,
		});
	});
});
