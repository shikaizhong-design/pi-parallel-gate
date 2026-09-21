/**
 * scope.ts — glob 规范化与保守相交判定（Layer 0）
 *
 * 保守方向：宁多判冲突（代价是退串行，安全方向），不漏判。
 * 出现 `[` `]` `{` `}` `!` 一律判相交（ ponytail: 完整 glob 语义相交无必要）。
 */

/** 规范化 glob：反斜杠转正、去 `./`、去尾 `/`、小写（macOS 大小写不敏感）。 */
export function normalizeGlob(pattern: string): string {
	let p = pattern.trim().replace(/\\/g, "/");
	while (p.startsWith("./")) p = p.slice(2);
	p = p.replace(/\/+/g, "/").replace(/\/$/, "");
	return p.toLowerCase();
}

/** glob 的静态前缀：第一个通配字符之前的部分，截到路径段边界。 */
function staticPrefix(pattern: string): string {
	const i = pattern.search(/[*?[\]{}!]/);
	const head = i === -1 ? pattern : pattern.slice(0, i);
	const slash = head.lastIndexOf("/");
	// 通配落在段中间时，前缀只保留到上一段边界（如 "src/te*.ts" → "src/"）
	return slash === -1 ? (i === -1 ? head : "") : head.slice(0, slash + 1);
}

function hasUnsupportedConstruct(pattern: string): boolean {
	return /[[\]{}!]/.test(pattern);
}

/** 路径段边界上的前缀关系："a/b/" 是 "a/b/c.ts" 的前缀；"a/b" 也是 "a/b/c" 的段前缀。 */
function isSegmentPrefix(prefix: string, path: string): boolean {
	if (prefix === "") return true;
	if (path === prefix || path.startsWith(prefix)) return true;
	const bare = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
	return path === bare || path.startsWith(bare + "/");
}

/**
 * 两个 glob 是否可能命中同一文件（保守判定）。
 * 无法精确判定时（含 `[]{}!` 或前缀关系模糊）一律返回 true。
 */
export function globsMayOverlap(a: string, b: string): boolean {
	const na = normalizeGlob(a);
	const nb = normalizeGlob(b);
	if (na === "" || nb === "") return true; // 空 pattern 视作匹配一切，保守
	if (hasUnsupportedConstruct(na) || hasUnsupportedConstruct(nb)) return true;
	const pa = staticPrefix(na);
	const pb = staticPrefix(nb);
	if (pa === "" || pb === "") return true; // 一方可能匹配任意路径
	// 段边界上前缀互为前缀 → 可能相交；否则不相交
	if (isSegmentPrefix(pa, pb) || isSegmentPrefix(pb, pa)) {
		// "src/a.ts" 与 "src/b.ts"：静态前缀分别是整串（无通配），互不为前缀 → 不相交
		// "src/**" 与 "src/utils/**"：前缀 "src/" 互为前缀 → 相交
		const fullA = na.includes("*") || na.includes("?");
		const fullB = nb.includes("*") || nb.includes("?");
		if (!fullA && !fullB) return na === nb; // 两个都是字面路径
		return true;
	}
	return false;
}

export interface ScopeEdge {
	a: string;
	b: string;
	files: [string, string];
}

/**
 * 读写分离的冲突判定：writes×writes、writes×reads 出边；reads×reads 不判。
 */
export function findScopeConflicts(
	subtasks: Array<{ id: string; reads: string[]; writes: string[] }>,
): ScopeEdge[] {
	const edges: ScopeEdge[] = [];
	for (let i = 0; i < subtasks.length; i++) {
		for (let j = i + 1; j < subtasks.length; j++) {
			const A = subtasks[i];
			const B = subtasks[j];
			outer: for (const w of [...A.writes]) {
				for (const r of [...B.writes, ...B.reads]) {
					if (globsMayOverlap(w, r)) {
						edges.push({ a: A.id, b: B.id, files: [w, r] });
						break outer;
					}
				}
			}
			if (edges.some((e) => e.a === A.id && e.b === B.id)) continue;
			outer2: for (const w of [...B.writes]) {
				for (const r of [...A.reads]) {
					if (globsMayOverlap(w, r)) {
						edges.push({ a: A.id, b: B.id, files: [w, r] });
						break outer2;
					}
				}
			}
		}
	}
	return edges;
}

/** side_effects 规范化后字符串相同 → 冲突（如两个任务都起 :3000）。 */
export function findSideEffectConflicts(
	subtasks: Array<{ id: string; side_effects: string[] }>,
): Array<{ a: string; b: string; effect: string }> {
	const edges: Array<{ a: string; b: string; effect: string }> = [];
	for (let i = 0; i < subtasks.length; i++) {
		for (let j = i + 1; j < subtasks.length; j++) {
			const sa = new Set(subtasks[i].side_effects.map((s) => s.trim().toLowerCase()).filter(Boolean));
			for (const raw of subtasks[j].side_effects) {
				const s = raw.trim().toLowerCase();
				if (s && sa.has(s)) {
					edges.push({ a: subtasks[i].id, b: subtasks[j].id, effect: raw.trim() });
					break;
				}
			}
		}
	}
	return edges;
}
