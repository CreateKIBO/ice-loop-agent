// 修改提案的字符级差异（纯函数，无依赖；desktop/tests/inline-diff.test.cjs 直接加载）。
// 中文没有空格分词，按字符比较最直观；以 code point 为单位，不拆开 emoji 等代理对。

export type DiffKind = "same" | "add" | "del";
export type DiffPart = { kind: DiffKind; text: string };
export type InlineDiff = { before: DiffPart[]; after: DiffPart[]; truncated: boolean };

// LCS 表的单元格上限（约 5 MB 的 Uint16Array）。超过就退化为"整段替换"，
// 不让一次超长段落比较卡住界面。
const MAX_CELLS = 2_500_000;
// 夹在两处修改之间、不超过这个长度的相同片段并入修改：
// 否则"的""了"这类常用字会把一处改写切成很多碎块，反而难读。
const MAX_GLUE = 2;

function merge(parts: DiffPart[]): DiffPart[] {
  const out: DiffPart[] = [];
  for (const part of parts) {
    if (!part.text) continue;
    const last = out[out.length - 1];
    if (last && last.kind === part.kind) last.text += part.text;
    else out.push({ ...part });
  }
  return out;
}

/** 把相邻的 del/add 归并成"先删后加"的一组，便于两栏分别展示。 */
function normalize(parts: DiffPart[]): DiffPart[] {
  const out: DiffPart[] = [];
  let del = "", add = "";
  const flush = () => {
    if (del) out.push({ kind: "del", text: del });
    if (add) out.push({ kind: "add", text: add });
    del = ""; add = "";
  };
  for (const part of parts) {
    if (part.kind === "same") { flush(); out.push(part); }
    else if (part.kind === "del") del += part.text;
    else add += part.text;
  }
  flush();
  return merge(out);
}

function glueShortEqualities(parts: DiffPart[]): DiffPart[] {
  const out: DiffPart[] = [];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    const between = index > 0 && index < parts.length - 1
      && parts[index - 1].kind !== "same" && parts[index + 1].kind !== "same";
    if (part.kind === "same" && between && Array.from(part.text).length <= MAX_GLUE) {
      out.push({ kind: "del", text: part.text }, { kind: "add", text: part.text });
    } else {
      out.push(part);
    }
  }
  return normalize(out);
}

function lcsDiff(a: string[], b: string[]): DiffPart[] {
  const n = a.length, m = b.length, width = m + 1;
  // dp[i*width+j] = a[i..] 与 b[j..] 的 LCS 长度。n*m <= MAX_CELLS 时 min(n,m) < 65536。
  const dp = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] = a[i] === b[j]
        ? dp[(i + 1) * width + j + 1] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }
  const parts: DiffPart[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { parts.push({ kind: "same", text: a[i] }); i++; j++; }
    else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) { parts.push({ kind: "del", text: a[i] }); i++; }
    else { parts.push({ kind: "add", text: b[j] }); j++; }
  }
  while (i < n) parts.push({ kind: "del", text: a[i++] });
  while (j < m) parts.push({ kind: "add", text: b[j++] });
  return merge(parts);
}

export function inlineDiff(before: string, after: string): InlineDiff {
  // Strip shared UTF-16 ranges before allocating code-point arrays. Very large
  // shared prefixes/suffixes should stay strings rather than millions of entries.
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  // A differing low surrogate may leave the shared high surrogate at the boundary.
  if (start > 0 && /[\uD800-\uDBFF]/.test(before[start - 1])) start--;
  let endA = before.length, endB = after.length;
  while (endA > start && endB > start && before[endA - 1] === after[endB - 1]) { endA--; endB--; }
  if (endA < before.length && /[\uDC00-\uDFFF]/.test(before[endA])) { endA++; endB++; }

  const textA = before.slice(start, endA), textB = after.slice(start, endB);
  // UTF-16 lengths bound code-point count from above. Refuse a large allocation
  // conservatively, even when its DP cell product would be small (e.g. insertion).
  const truncated = textA.length > 20000 || textB.length > 20000 || textA.length * textB.length > MAX_CELLS;
  const middle = truncated
    ? [{ kind: "del" as const, text: textA }, { kind: "add" as const, text: textB }]
    : lcsDiff(Array.from(textA), Array.from(textB));

  const parts = glueShortEqualities(merge([
    { kind: "same", text: before.slice(0, start) },
    ...middle,
    { kind: "same", text: before.slice(endA) },
  ]));
  return {
    before: parts.filter(part => part.kind !== "add"),
    after: parts.filter(part => part.kind !== "del"),
    truncated,
  };
}
