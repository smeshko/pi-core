import assert from "node:assert/strict";
import test from "node:test";

import { LazyConnection } from "../src/lazy-connection.ts";

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

test("does not connect until ensure is called", async () => {
	let calls = 0;
	const connection = new LazyConnection();

	assert.equal(connection.state, "idle");
	assert.equal(calls, 0);

	await connection.ensure(async () => {
		calls++;
	});

	assert.equal(calls, 1);
	assert.equal(connection.state, "connected");
});

test("shares one in-flight connection attempt", async () => {
	let calls = 0;
	const gate = deferred();
	const connection = new LazyConnection();
	const connect = async () => {
		calls++;
		await gate.promise;
	};

	const first = connection.ensure(connect);
	const second = connection.ensure(connect);

	assert.equal(first, second);
	assert.equal(calls, 1);
	assert.equal(connection.state, "connecting");

	gate.resolve();
	await Promise.all([first, second]);
	assert.equal(connection.state, "connected");
});

test("returns to idle after a failed attempt so it can retry", async () => {
	let calls = 0;
	const connection = new LazyConnection();

	await assert.rejects(
		connection.ensure(async () => {
			calls++;
			throw new Error("unavailable");
		}),
		/unavailable/,
	);
	assert.equal(connection.state, "idle");

	await connection.ensure(async () => {
		calls++;
	});
	assert.equal(calls, 2);
	assert.equal(connection.state, "connected");
});

test("reset waits for an in-flight connection before disconnecting", async () => {
	const events: string[] = [];
	const gate = deferred();
	const connection = new LazyConnection();

	void connection.ensure(async () => {
		events.push("connect-start");
		await gate.promise;
		events.push("connect-end");
	});
	const reset = connection.reset(async () => {
		events.push("disconnect");
	});

	await Promise.resolve();
	assert.deepEqual(events, ["connect-start"]);
	gate.resolve();
	await reset;

	assert.deepEqual(events, ["connect-start", "connect-end", "disconnect"]);
	assert.equal(connection.state, "idle");
});
