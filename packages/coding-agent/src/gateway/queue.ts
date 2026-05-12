export class AkashaGatewayQueue {
	private readonly tails = new Map<string, Promise<void>>();

	enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
		const previous = this.tails.get(key) ?? Promise.resolve();
		const run = previous.catch(() => undefined).then(task);
		const tail = run.then(
			() => undefined,
			() => undefined,
		);
		this.tails.set(key, tail);
		tail
			.finally(() => {
				if (this.tails.get(key) === tail) {
					this.tails.delete(key);
				}
			})
			.catch(() => undefined);
		return run;
	}

	isBusy(key: string): boolean {
		return this.tails.has(key);
	}

	pendingKeys(): string[] {
		return [...this.tails.keys()].sort();
	}
}
