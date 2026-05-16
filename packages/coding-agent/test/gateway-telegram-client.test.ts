import { describe, expect, it } from "vitest";
import {
	isRetryableTelegramError,
	TelegramApiError,
	type TelegramApiError as TelegramApiErrorShape,
	TelegramClient,
} from "../src/gateway/telegram-client.js";

type TelegramFetch = NonNullable<ConstructorParameters<typeof TelegramClient>[0]["fetchImpl"]>;

describe("TelegramClient", () => {
	it("calls getUpdates with offset and timeout", async () => {
		const calls: Array<{ url: string; body: unknown }> = [];
		const client = new TelegramClient({
			token: "token",
			fetchImpl: fakeFetch(calls, { ok: true, result: [{ update_id: 42 }] }),
		});

		const updates = await client.getUpdates({ offset: 41, timeoutSeconds: 10 });

		expect(updates).toEqual([{ update_id: 42 }]);
		expect(calls[0].url).toBe("https://api.telegram.org/bottoken/getUpdates");
		expect(calls[0].body).toMatchObject({ offset: 41, timeout: 10 });
	});

	it("sends text messages through sendMessage", async () => {
		const calls: Array<{ url: string; body: unknown }> = [];
		const client = new TelegramClient({
			token: "token",
			fetchImpl: fakeFetch(calls, {
				ok: true,
				result: { message_id: 1, date: 1, chat: { id: 123, type: "private" } },
			}),
		});

		await client.sendMessage(123, "hello");

		expect(calls[0].url).toBe("https://api.telegram.org/bottoken/sendMessage");
		expect(calls[0].body).toMatchObject({ chat_id: 123, text: "hello", parse_mode: "HTML" });
	});

	it("formats markdown messages as Telegram HTML", async () => {
		const calls: Array<{ url: string; body: unknown }> = [];
		const client = new TelegramClient({
			token: "token",
			fetchImpl: fakeFetch(calls, {
				ok: true,
				result: { message_id: 1, date: 1, chat: { id: 123, type: "private" } },
			}),
		});

		await client.sendMessage(123, "**Akasha** says `hi` and <keeps tags literal>");

		expect(calls[0].body).toMatchObject({
			chat_id: 123,
			text: "<b>Akasha</b> says <code>hi</code> and &lt;keeps tags literal&gt;",
			parse_mode: "HTML",
		});
	});

	it("uses single newlines between Telegram markdown blocks", async () => {
		const calls: Array<{ url: string; body: unknown }> = [];
		const client = new TelegramClient({
			token: "token",
			fetchImpl: fakeFetch(calls, {
				ok: true,
				result: { message_id: 1, date: 1, chat: { id: 123, type: "private" } },
			}),
		});

		await client.sendMessage(123, "# 核心能力\n\n第一段\n\n- 一\n- 二");

		expect(calls[0].body).toMatchObject({
			text: "<b>核心能力</b>\n第一段\n- 一\n- 二",
			parse_mode: "HTML",
		});
		expect((calls[0].body as { text: string }).text).not.toContain("\n\n");
	});

	it("falls back to stripped plain text when Telegram rejects HTML parsing", async () => {
		const calls: Array<{ url: string; body: unknown }> = [];
		const client = new TelegramClient({
			token: "token",
			fetchImpl: fakeFetchSequence(calls, [
				{
					status: 400,
					payload: {
						ok: false,
						description: "Bad Request: can't parse entities: Unsupported start tag",
					},
				},
				{
					payload: {
						ok: true,
						result: { message_id: 2, date: 1, chat: { id: 123, type: "private" } },
					},
				},
			]),
		});

		await client.sendMessage(123, "**Akasha** says `hi`");

		expect(calls).toHaveLength(2);
		expect(calls[0].body).toMatchObject({
			text: "<b>Akasha</b> says <code>hi</code>",
			parse_mode: "HTML",
		});
		expect(calls[1].body).toMatchObject({ text: "Akasha says hi" });
		expect(calls[1].body).not.toHaveProperty("parse_mode");
	});

	it("registers native Telegram command menus", async () => {
		const calls: Array<{ url: string; body: unknown }> = [];
		const client = new TelegramClient({
			token: "token",
			fetchImpl: fakeFetch(calls, { ok: true, result: true }),
		});

		await client.setMyCommands([{ command: "new", description: "Start a new Akasha session" }]);

		expect(calls[0].url).toBe("https://api.telegram.org/bottoken/setMyCommands");
		expect(calls[0].body).toEqual({
			commands: [{ command: "new", description: "Start a new Akasha session" }],
		});
	});

	it("updates Telegram bot profile descriptions", async () => {
		const calls: Array<{ url: string; body: unknown }> = [];
		const client = new TelegramClient({
			token: "token",
			fetchImpl: fakeFetch(calls, { ok: true, result: true }),
		});

		await client.setMyDescription("Akasha: Knowing. Doing. Being.");
		await client.setMyShortDescription("Akasha: Knowing. Doing. Being.");

		expect(calls[0]).toEqual({
			url: "https://api.telegram.org/bottoken/setMyDescription",
			body: { description: "Akasha: Knowing. Doing. Being." },
		});
		expect(calls[1]).toEqual({
			url: "https://api.telegram.org/bottoken/setMyShortDescription",
			body: { short_description: "Akasha: Knowing. Doing. Being." },
		});
	});

	it("surfaces Telegram retry_after as an API error", async () => {
		const client = new TelegramClient({
			token: "token",
			fetchImpl: fakeFetch(
				[],
				{
					ok: false,
					description: "Too Many Requests",
					parameters: { retry_after: 7 },
				},
				429,
			),
		});

		await expect(client.getMe()).rejects.toMatchObject({
			name: "TelegramApiError",
			status: 429,
			retryAfterSeconds: 7,
		} satisfies Partial<TelegramApiErrorShape>);
	});

	it("classifies 5xx and network errors as retryable", () => {
		expect(isRetryableTelegramError(new TelegramApiError("server error", 500))).toBe(true);
		expect(isRetryableTelegramError(new Error("fetch failed"))).toBe(true);
	});

	it("classifies malformed request errors as non-retryable", () => {
		expect(isRetryableTelegramError(new TelegramApiError("Bad Request", 400))).toBe(false);
	});
});

function fakeFetch(calls: Array<{ url: string; body: unknown }>, payload: unknown, status = 200): TelegramFetch {
	return fakeFetchSequence(calls, [{ payload, status }]);
}

function fakeFetchSequence(
	calls: Array<{ url: string; body: unknown }>,
	responses: Array<{ payload: unknown; status?: number }>,
): TelegramFetch {
	let index = 0;
	return (async (url, init) => {
		const bodyText = typeof init?.body === "string" ? init.body : "{}";
		calls.push({ url: String(url), body: JSON.parse(bodyText) });
		const response = responses[Math.min(index, responses.length - 1)];
		index++;
		const status = response?.status ?? 200;
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => response?.payload,
			arrayBuffer: async () => new ArrayBuffer(0),
		} as Awaited<ReturnType<TelegramFetch>>;
	}) as TelegramFetch;
}
