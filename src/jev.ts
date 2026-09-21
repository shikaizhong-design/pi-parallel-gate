/**
 * jev.ts — TypeSafe System One (Jev) HTTP 客户端
 *
 * POST https://api.typesafe.ai/v1/systemone
 * 请求 {state, model, questions:{id:{type:"noul",instructions,criteria}}}
 * 响应 {answers:{id:{type:"noul",noul:number}}, usage}
 * noul ∈ [0,1] = 答案为「是」的概率。
 *
 * 分批（≤20 题/请求）、429/529 指数退避、总超时。
 */

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
const BATCH_SIZE = 20;
const PER_REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;

export interface NoulQuestion {
	instructions: string;
	criteria: { true: string; false: string };
}

export interface JevUsage {
	input_tokens?: number;
	output_tokens?: number;
	[key: string]: unknown;
}

export interface JevResult {
	/** question id → p（答案为「是」的概率） */
	probabilities: Record<string, number>;
	usage: JevUsage;
	latencyMs: number;
	batches: number;
}

export class JevError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "JevError";
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function postBatch(
	apiKey: string,
	state: string,
	questions: Record<string, NoulQuestion>,
): Promise<{ answers: Record<string, number>; usage: JevUsage }> {
	const body = {
		state,
		model: MODEL,
		questions: Object.fromEntries(
			Object.entries(questions).map(([id, q]) => [
				id,
				{ type: "noul", instructions: q.instructions, criteria: q.criteria },
			]),
		),
	};
	let lastError: Error | undefined;
	for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
		if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1)); // 1s, 2s
		try {
			const res = await fetch(ENDPOINT, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS),
			});
			if (res.status === 429 || res.status === 529) {
				lastError = new JevError(`TypeSafe ${res.status}`, res.status);
				continue;
			}
			if (!res.ok) {
				const text = await res.text().catch(() => "");
				// 4xx（除 429）不重试：请求本身有问题
				throw new JevError(`TypeSafe ${res.status}: ${text.slice(0, 300)}`, res.status);
			}
			const data = (await res.json()) as {
				answers?: Record<string, { type?: string; noul?: number }>;
				usage?: JevUsage;
			};
			const answers: Record<string, number> = {};
			for (const [id, ans] of Object.entries(data.answers ?? {})) {
				if (typeof ans?.noul === "number") answers[id] = ans.noul;
			}
			const missing = Object.keys(questions).filter((id) => !(id in answers));
			if (missing.length > 0) {
				throw new JevError(`TypeSafe response missing answers for: ${missing.join(", ")}`);
			}
			return { answers, usage: data.usage ?? {} };
		} catch (error) {
			if (error instanceof JevError && error.status && error.status < 500 && error.status !== 429) {
				throw error; // 客户端错误不重试
			}
			lastError = error instanceof Error ? error : new Error(String(error));
		}
	}
	throw lastError ?? new JevError("TypeSafe request failed");
}

/** 分批并发调用，聚合所有答案。任何一批失败整体抛错（由调用方降级）。 */
export async function evaluateNoul(
	apiKey: string,
	state: string,
	questions: Record<string, NoulQuestion>,
): Promise<JevResult> {
	const entries = Object.entries(questions);
	const batches: Array<Record<string, NoulQuestion>> = [];
	for (let i = 0; i < entries.length; i += BATCH_SIZE) {
		batches.push(Object.fromEntries(entries.slice(i, i + BATCH_SIZE)));
	}
	const start = Date.now();
	const results = await Promise.all(batches.map((b) => postBatch(apiKey, state, b)));
	const probabilities: Record<string, number> = {};
	const usage: JevUsage = { input_tokens: 0, output_tokens: 0 };
	for (const r of results) {
		Object.assign(probabilities, r.answers);
		usage.input_tokens = (usage.input_tokens as number) + ((r.usage.input_tokens as number) ?? 0);
		usage.output_tokens = (usage.output_tokens as number) + ((r.usage.output_tokens as number) ?? 0);
	}
	return { probabilities, usage, latencyMs: Date.now() - start, batches: batches.length };
}
