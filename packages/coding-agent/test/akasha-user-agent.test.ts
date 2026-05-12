import { describe, expect, it } from "vitest";
import { getAkashaUserAgent } from "../src/utils/akasha-user-agent.js";

describe("getAkashaUserAgent", () => {
	it("formats the Akasha user agent", () => {
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		const userAgent = getAkashaUserAgent("1.2.3");

		expect(userAgent).toBe(`akasha/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(/^akasha\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});
});
