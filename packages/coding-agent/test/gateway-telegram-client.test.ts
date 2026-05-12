import { describe, expect, it } from "vitest";
import { type TelegramApiError, TelegramClient } from "../src/gateway/telegram-client.js";

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
		expect(calls[0].body).toMatchObject({ chat_id: 123, text: "hello" });
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
		} satisfies Partial<TelegramApiError>);
	});
});

function fakeFetch(calls: Array<{ url: string; body: unknown }>, payload: unknown, status = 200): TelegramFetch {
	return (async (url, init) => {
		const bodyText = typeof init?.body === "string" ? init.body : "{}";
		calls.push({ url: String(url), body: JSON.parse(bodyText) });
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => payload,
			arrayBuffer: async () => new ArrayBuffer(0),
		} as Awaited<ReturnType<TelegramFetch>>;
	}) as TelegramFetch;
}
