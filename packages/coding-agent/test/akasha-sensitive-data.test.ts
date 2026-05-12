import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTemporalBrief } from "../src/core/akasha/brief.js";
import { JsonlAkashaStore } from "../src/core/akasha/jsonl-store.js";
import { createMemoryGovernanceEvent } from "../src/core/akasha/memory-governance.js";
import { createRedactionEvent } from "../src/core/akasha/redaction.js";
import { sanitizeAkashaEventDraft, scanAkashaSecrets } from "../src/core/akasha/sensitive-data.js";

describe("Akasha sensitive data handling", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "akasha-sensitive-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("detects and redacts common secrets in event drafts", () => {
		const draft = {
			kind: "command.executed" as const,
			sessionId: "session-1",
			streamId: "session:session-1",
			eventTime: "2026-05-11T00:00:00.000Z",
			actor: "tool" as const,
			payload: {
				command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456' https://example.test",
				text: "sk-abcdefghijklmnopqrstuvwxyz1234567890",
			},
		};

		expect(scanAkashaSecrets(draft).secretTypes).toEqual(["openai_key", "bearer_token"]);
		expect(sanitizeAkashaEventDraft(draft).payload?.text).toBe("[redacted:openai_key]");
	});

	it("redacts secrets before appending to the JSONL store by default", () => {
		const store = new JsonlAkashaStore(join(tempDir, "events.jsonl"));

		const event = store.append({
			kind: "message.user.submitted",
			sessionId: "session-1",
			streamId: "session:session-1",
			eventTime: "2026-05-11T00:00:00.000Z",
			actor: "user",
			payload: { text: "token=abcdefghijklmnopqrstuvwxyz123456" },
		});

		expect(event.payload.text).toBe("token=[redacted:api_key_assignment]");
		expect(event.payload.akashaRedactedSecretTypes).toEqual(["api_key_assignment"]);
	});

	it("uses redaction projections when building temporal briefs", () => {
		const store = new JsonlAkashaStore(join(tempDir, "events.jsonl"), { redactSecrets: false });
		const target = store.append({
			kind: "message.user.submitted",
			sessionId: "session-1",
			streamId: "session:session-1",
			eventTime: "2026-05-11T00:00:00.000Z",
			actor: "user",
			payload: { text: "secret text" },
		});
		store.append(createRedactionEvent(target, ["payload.text"], "privacy"));

		const brief = buildTemporalBrief(store, { maxEvents: 4 });

		expect(brief?.text).toContain("[redacted]");
		expect(brief?.text).not.toContain("secret text");
	});

	it("omits suppressed events from temporal briefs", () => {
		const store = new JsonlAkashaStore(join(tempDir, "events.jsonl"), { redactSecrets: false });
		const target = store.append({
			kind: "message.user.submitted",
			sessionId: "session-1",
			streamId: "session:session-1",
			eventTime: "2026-05-11T00:00:00.000Z",
			actor: "user",
			payload: { text: "temporary preference should disappear" },
		});
		store.append({
			kind: "preference.inferred",
			sessionId: "session-1",
			streamId: "session:session-1",
			eventTime: "2026-05-11T00:01:00.000Z",
			actor: "system",
			parentEventIds: [target.eventId],
			payload: { statement: "temporary derived preference", supportingEventIds: [target.eventId] },
		});
		store.append(createMemoryGovernanceEvent(target, "suppress", "temporary"));
		store.append({
			kind: "message.user.submitted",
			sessionId: "session-1",
			streamId: "session:session-1",
			eventTime: "2026-05-11T00:02:00.000Z",
			actor: "user",
			payload: { text: "stable intent remains visible" },
		});

		const brief = buildTemporalBrief(store, { maxEvents: 8 });

		expect(brief?.text).toContain("stable intent remains visible");
		expect(brief?.text).not.toContain("temporary preference should disappear");
		expect(brief?.text).not.toContain("temporary derived preference");
	});
});
