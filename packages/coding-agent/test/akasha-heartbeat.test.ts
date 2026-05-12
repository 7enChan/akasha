import { afterEach, describe, expect, it, vi } from "vitest";
import { createAkashaHeartbeat } from "../src/core/akasha/heartbeat.js";

describe("Akasha heartbeat", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("runs maintenance on a wall-clock interval and stops cleanly", async () => {
		vi.useFakeTimers();
		const runs: string[] = [];
		const heartbeat = createAkashaHeartbeat({
			intervalMinutes: 1,
			run: () => {
				runs.push("run");
			},
		});

		heartbeat.start();
		expect(heartbeat.isRunning()).toBe(true);

		await vi.advanceTimersByTimeAsync(60_000);
		expect(runs).toEqual(["run"]);

		heartbeat.stop();
		expect(heartbeat.isRunning()).toBe(false);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(runs).toEqual(["run"]);
	});

	it("skips overlapping runs and reports errors without throwing", async () => {
		let release: (() => void) | undefined;
		const run = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const errors: unknown[] = [];
		const heartbeat = createAkashaHeartbeat({
			intervalMinutes: 1,
			run,
			onError: (error) => errors.push(error),
		});

		const firstRun = heartbeat.runNow();
		await heartbeat.runNow();
		expect(run).toHaveBeenCalledTimes(1);
		release?.();
		await firstRun;

		const failing = createAkashaHeartbeat({
			intervalMinutes: 1,
			run: () => {
				throw new Error("maintenance failed");
			},
			onError: (error) => errors.push(error),
		});
		await expect(failing.runNow()).resolves.toBeUndefined();
		expect(errors).toHaveLength(1);
		expect(errors[0]).toBeInstanceOf(Error);
	});
});
