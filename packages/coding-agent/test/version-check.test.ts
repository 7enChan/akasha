import { afterEach, describe, expect, it, vi } from "vitest";
import {
	checkForNewAkashaVersion,
	comparePackageVersions,
	getLatestAkashaRelease,
	getLatestAkashaVersion,
	isNewerPackageVersion,
} from "../src/utils/version-check.js";

const originalSkipVersionCheck = process.env.AKASHA_SKIP_VERSION_CHECK;
const originalOffline = process.env.AKASHA_OFFLINE;

afterEach(() => {
	vi.unstubAllGlobals();
	if (originalSkipVersionCheck === undefined) {
		delete process.env.AKASHA_SKIP_VERSION_CHECK;
	} else {
		process.env.AKASHA_SKIP_VERSION_CHECK = originalSkipVersionCheck;
	}
	if (originalOffline === undefined) {
		delete process.env.AKASHA_OFFLINE;
	} else {
		process.env.AKASHA_OFFLINE = originalOffline;
	}
});

describe("version checks", () => {
	it("compares package versions", () => {
		expect(comparePackageVersions("0.70.6", "0.70.5")).toBeGreaterThan(0);
		expect(comparePackageVersions("0.70.5", "0.70.5")).toBe(0);
		expect(comparePackageVersions("0.70.4", "0.70.5")).toBeLessThan(0);
		expect(isNewerPackageVersion("0.70.5", "0.70.5")).toBe(false);
		expect(isNewerPackageVersion("0.70.6", "0.70.5")).toBe(true);
	});

	it("returns only newer versions", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.3" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewAkashaVersion("1.2.3")).resolves.toBeUndefined();
		await expect(checkForNewAkashaVersion("1.2.2")).resolves.toBe("1.2.3");
	});

	it("uses the Akasha GitHub release API with an Akasha user agent", async () => {
		const fetchMock = vi.fn(async () => Response.json({ tag_name: "v1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestAkashaVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.github.com/repos/7enChan/akasha/releases/latest",
			expect.objectContaining({
				headers: expect.objectContaining({
					"User-Agent": expect.stringMatching(/^akasha\/1\.2\.3 /),
					accept: "application/json",
				}),
			}),
		);
	});

	it("returns the active package name from the version check api", async () => {
		const fetchMock = vi.fn(async () => Response.json({ packageName: "@new-scope/akasha", version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestAkashaRelease("1.2.3")).resolves.toEqual({
			packageName: "@new-scope/akasha",
			version: "1.2.4",
		});
	});

	it("skips api calls when version checks are disabled", async () => {
		process.env.AKASHA_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestAkashaVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
