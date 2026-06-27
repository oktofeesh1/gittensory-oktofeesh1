// ReDoS analyzer (#1503). Flags regex literals INTRODUCED by the PR (added `+` diff lines) that are vulnerable to
// catastrophic backtracking — a group quantified by an unbounded quantifier (`+`, `*`, `{n,}`) whose body ALSO
// contains an unbounded quantifier: the classic `(a+)+` shape that turns attacker-controlled input into a DoS.
// Pure compute, no network, no external detector (structural-only → high precision: linear shapes like `(abc)+`
// are NOT flagged). Line-cited via hunk headers, mirroring the actions-pin analyzer.
import type { EnrichRequest, RedosFinding } from "../types.js";

// Every loop runs over an attacker-controlled patch, so each is bounded.
const MAX_FINDINGS = 25; // keep the brief bounded
const MAX_PATTERN_CHARS = 1000; // ignore absurdly long literals (a hand-written regex is never this long)
const MAX_LINE_CHARS = 2000; // skip extraction on pathologically long lines (defensive)
const REPORT_CHARS = 80; // truncate the reported pattern so the brief stays readable

// A `/.../flags` literal in regex position (line start or an operator/punctuation that cannot begin a division),
// OR a `new RegExp("…")` / `RegExp('…')` constructor argument. The structural check below filters non-ReDoS noise,
// so a slightly-loose extraction here cannot, on its own, produce a false ReDoS finding. Both patterns use only
// non-overlapping alternations + negated classes, so they are themselves linear-time (no self-ReDoS).
const LITERAL_RE =
  /(?:^|[=(,:?&|!{[;\s])\/((?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+)\/[a-z]*/g;
const CTOR_RE = /\bRegExp\s*\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;

/** Extract candidate regex SOURCES from one line of added code (`/.../` literals + `RegExp(...)` string args). */
export function extractRegexSources(line: string): string[] {
  const sources: string[] = [];
  if (line.length > MAX_LINE_CHARS) return sources;
  LITERAL_RE.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = LITERAL_RE.exec(line)); ) {
    if (m[1] && m[1].length <= MAX_PATTERN_CHARS) sources.push(m[1]);
  }
  CTOR_RE.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = CTOR_RE.exec(line)); ) {
    if (m[2] && m[2].length <= MAX_PATTERN_CHARS) sources.push(m[2]);
  }
  return sources;
}

// An unbounded quantifier (`+`, `*`, or `{n,}`) at index `i`? `{n}` and `{n,m}` are bounded and ignored.
function unboundedQuantifierAt(p: string, i: number): boolean {
  const c = p[i];
  if (c === "+" || c === "*") return true;
  if (c === "{") return /^\{\d*,\}/.test(p.slice(i));
  return false;
}

// Does the group body p[open+1 .. close-1] contain an unbounded quantifier (ignoring escapes + char classes,
// inside which `+`/`*` are literal)?
function bodyHasUnboundedQuantifier(
  p: string,
  open: number,
  close: number,
): boolean {
  let i = open + 1;
  let inClass = false;
  while (i < close) {
    const c = p[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      i++;
      continue;
    }
    if (c === "[") {
      inClass = true;
      i++;
      continue;
    }
    if (unboundedQuantifierAt(p, i)) return true;
    i++;
  }
  return false;
}

/** Catastrophic-backtracking detector: a group `(…)` quantified by an unbounded quantifier whose body ALSO
 *  contains an unbounded quantifier — `(a+)+`, `(\d+)*`, `(.*)+`, … Returns false for linear shapes like `(abc)+`. */
export function hasCatastrophicBacktracking(pattern: string): boolean {
  const openStack: number[] = [];
  let i = 0;
  let inClass = false;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      i++;
      continue;
    }
    if (c === "[") {
      inClass = true;
      i++;
      continue;
    }
    if (c === "(") {
      openStack.push(i);
      i++;
      continue;
    }
    if (c === ")") {
      const open = openStack.pop();
      if (
        open !== undefined &&
        unboundedQuantifierAt(pattern, i + 1) &&
        bodyHasUnboundedQuantifier(pattern, open, i)
      ) {
        return true;
      }
      i++;
      continue;
    }
    i++;
  }
  return false;
}

/** Scan one file patch's added lines for ReDoS-prone regex literals, line-cited via hunk headers. Pure. */
export function scanPatchForRedos(path: string, patch: string): RedosFinding[] {
  const findings: RedosFinding[] = [];
  let newLine = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (line.startsWith("+")) {
      for (const source of extractRegexSources(line.slice(1))) {
        if (hasCatastrophicBacktracking(source)) {
          findings.push({
            file: path,
            line: newLine,
            kind: "nested-quantifier",
            pattern: source.slice(0, REPORT_CHARS),
          });
        }
      }
      newLine++;
    } else if (!line.startsWith("-")) {
      newLine++;
    }
  }
  return findings;
}

/** Analyzer entrypoint: scan every changed file's added lines for ReDoS-prone regex literals. */
export async function scanRedos(req: EnrichRequest): Promise<RedosFinding[]> {
  const findings: RedosFinding[] = [];
  for (const file of req.files ?? []) {
    if (!file.patch) continue;
    for (const finding of scanPatchForRedos(file.path, file.patch)) {
      findings.push(finding);
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}
