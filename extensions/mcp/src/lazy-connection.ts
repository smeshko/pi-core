export type LazyConnectionState = "idle" | "connecting" | "connected";

/**
 * Coordinates one lazy connection attempt at a time and makes reset wait for an
 * in-flight attempt before disposing its resources.
 */
export class LazyConnection {
	private pending: Promise<void> | undefined;
	private currentState: LazyConnectionState = "idle";
	private readonly onStateChange: (state: LazyConnectionState) => void;

	constructor(onStateChange: (state: LazyConnectionState) => void = () => {}) {
		this.onStateChange = onStateChange;
	}

	get state(): LazyConnectionState {
		return this.currentState;
	}

	ensure(connect: () => Promise<void>): Promise<void> {
		if (this.currentState === "connected") return Promise.resolve();
		if (this.pending) return this.pending;

		this.setState("connecting");
		let attempt!: Promise<void>;
		attempt = (async () => {
			try {
				await connect();
				if (this.pending === attempt) this.setState("connected");
			} catch (error) {
				if (this.pending === attempt) this.setState("idle");
				throw error;
			} finally {
				if (this.pending === attempt) this.pending = undefined;
			}
		})();
		this.pending = attempt;
		return attempt;
	}

	async reset(disconnect: () => Promise<void>): Promise<void> {
		const pending = this.pending;
		if (pending) {
			try {
				await pending;
			} catch {
				// A failed connection has no usable resources, but disconnect still gets
				// the chance to clean up partially established transports.
			}
		}

		await disconnect();
		this.pending = undefined;
		this.setState("idle");
	}

	private setState(state: LazyConnectionState): void {
		if (this.currentState === state) return;
		this.currentState = state;
		this.onStateChange(state);
	}
}
