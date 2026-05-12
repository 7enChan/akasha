export interface AkashaHeartbeatOptions {
	intervalMinutes: number;
	run: () => void | Promise<void>;
	onError?: (error: unknown) => void;
}

export interface AkashaHeartbeatController {
	start(): void;
	stop(): void;
	runNow(): Promise<void>;
	isRunning(): boolean;
}

export function createAkashaHeartbeat(options: AkashaHeartbeatOptions): AkashaHeartbeatController {
	const intervalMs = Math.max(1, options.intervalMinutes) * 60_000;
	let timer: ReturnType<typeof setInterval> | undefined;
	let running = false;

	const runNow = async (): Promise<void> => {
		if (running) return;
		running = true;
		try {
			await options.run();
		} catch (error) {
			options.onError?.(error);
		} finally {
			running = false;
		}
	};

	return {
		start(): void {
			if (timer) return;
			timer = setInterval(() => {
				void runNow();
			}, intervalMs);
			if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") {
				timer.unref();
			}
		},
		stop(): void {
			if (!timer) return;
			clearInterval(timer);
			timer = undefined;
		},
		runNow,
		isRunning(): boolean {
			return !!timer;
		},
	};
}
