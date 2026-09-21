import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { evaluateNoul, JevError } from "../src/jev.ts";

// mock 全局 fetch：每个用例替换，结束恢复
const realFetch = globalThis.fetch;
let calls: Array<{ body: { questions: Record<string, unknown> } }> = [];
let handler: (body: unknown) => { status: number; payload?: unknown };

function mockResponse(status: number, payload: unknown) {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

beforeEach(() => {
	calls = [];
	handler = () => ({ status: 200, payload: { answers: {}, usage: {} } });
	globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
		const body = JSON.parse(init?.body ?? "{}");
		calls.push({ body });
		const r = handler(body);
		return mockResponse(r.status, r.payload ?? {});
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

const okPayload = (ids: string[]) => ({
	answers: Object.fromEntries(ids.map((id) => [id, { type: "noul", noul: 0.9 }])),
	usage: { input_tokens: 10, output_tokens: 1 },
});

const q = (n: number) =>
	Object.fromEntries(
		Array.from({ length: n }, (_, i) => [`q${i}`, { instructions: "?", criteria: { true: "y", false: "n" } }]),
	);

test("单批：≤20 题一次请求，概率与 usage 透传", async () => {
	const ids = Object.keys(q(3));
	handler = () => ({ status: 200, payload: okPayload(ids) });
	const r = await evaluateNoul("k", "state", q(3));
	assert.equal(calls.length, 1);
	assert.equal(r.batches, 1);
	assert.deepEqual(r.probabilities, { q0: 0.9, q1: 0.9, q2: 0.9 });
	assert.equal((r.usage.input_tokens as number) > 0, true);
});

test("分批：21 题 → 2 请求，答案聚合", async () => {
	const questions = q(21);
	handler = (body) => {
		const ids = Object.keys((body as { questions: object }).questions);
		return { status: 200, payload: okPayload(ids) };
	};
	const r = await evaluateNoul("k", "state", questions);
	assert.equal(calls.length, 2);
	assert.equal(r.batches, 2);
	assert.equal(Object.keys(r.probabilities).length, 21);
	assert.equal(r.usage.input_tokens, 20);
});

test("429 退避重试后成功", { timeout: 20_000 }, async () => {
	let n = 0;
	handler = () => {
		n++;
		return n < 3 ? { status: 429 } : { status: 200, payload: okPayload(["q0"]) };
	};
	const r = await evaluateNoul("k", "state", q(1));
	assert.equal(n, 3);
	assert.equal(r.probabilities.q0, 0.9);
});


test("4xx（非 429）不重试直接抛", async () => {
	let n = 0;
	handler = () => {
		n++;
		return { status: 401, payload: { error: "bad key" } };
	};
	await assert.rejects(() => evaluateNoul("k", "state", q(1)), (e: unknown) => {
		assert.ok(e instanceof JevError);
		assert.equal(e.status, 401);
		return true;
	});
	assert.equal(n, 1);
});

test("缺答案 → 抛错（由调用方降级）", async () => {
	handler = () => ({ status: 200, payload: { answers: {}, usage: {} } });
	await assert.rejects(() => evaluateNoul("k", "state", q(2)), /missing answers/);
});

test("noul 越界/NaN → fail-closed 抛错", async () => {
	handler = () => ({ status: 200, payload: { answers: { q0: { type: "noul", noul: 1.7 } }, usage: {} } });
	await assert.rejects(() => evaluateNoul("k", "state", q(1)), /invalid noul/);
	// NaN 无法走 JSON 线上格式（序列化为 null）→ 落到 missing-answers，同样 fail-closed
	handler = () => ({ status: 200, payload: { answers: { q0: { type: "noul", noul: Number.NaN } }, usage: {} } });
	await assert.rejects(() => evaluateNoul("k", "state", q(1)), /invalid noul|missing answers/);
});

test("持续 529 → 重试耗尽后抛错", { timeout: 20_000 }, async () => {
	handler = () => ({ status: 529 });
	await assert.rejects(() => evaluateNoul("k", "state", q(1)), /529|deadline/);
});
