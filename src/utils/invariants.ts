/**
 * Genesis invariant layer — design-contract guards for the palace core.
 *
 * This module is a deliberate ZERO-DEPENDENCY leaf: it imports nothing
 * (neither project code nor node builtins) so any module can guard itself
 * with it without import cycles or initialization-order hazards.
 */

/**
 * Design-contract assertion.
 *
 * Unlike test-only asserts, this guard is ALWAYS ON in every build — it is
 * never stripped behind a debug flag — and costs a single boolean branch,
 * which is why it is safe to place on zero-overhead-sensitive paths (hot
 * loops, per-query code). Use it for invariants the system cannot recover
 * from silently: violated assumptions must crash at the first execution
 * site, not surface later as subtly wrong data.
 *
 * @param condition The contract claim being made about program state.
 * @param message Human-readable statement of the violated contract.
 * @throws Error prefixed `[invariant]` when `condition` is falsy.
 */
export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[invariant] ${message}`);
}

/** ASCII identifier character (alnum or underscore) by char code. */
function isIdentCode(code: number): boolean {
  return (
    (code >= 97 && code <= 122) || // a-z
    (code >= 65 && code <= 90) || // A-Z
    (code >= 48 && code <= 57) || // 0-9
    code === 95 // _
  );
}

/**
 * Assert two-way parity between a statement's named-parameter REFERENCES
 * and the bind object it will be executed with.
 *
 * Every `@name` appearing in `sql` must have a key in `bind`, and every
 * key in `bind` must be referenced by `sql`. `@name` occurrences inside
 * NON-CODE regions are prose, not references, and are skipped by a small
 * lexing state machine that tracks five states:
 *
 *  - single-quoted literals `'...'` (with `''`-escaped quotes),
 *  - double-quoted identifiers `"..."` (with `""`-escaped quotes),
 *  - line comments `-- ...` (to end of line),
 *  - block comments `/* ... *\/` (non-nesting),
 *  - code (everything else — the only state where `@` counts).
 *
 * Rationale: hand-assembled SQL from conditional fragments makes it easy
 * to add a parameter to one place but not the other — a misalignment with
 * no compile-time symptom. This check turns that whole bug class into a
 * loud, immediate failure carrying the offending key names.
 *
 * @throws Error prefixed `[invariant]` listing missing and/or unused keys.
 */
export function assertNamedParamParity(sql: string, bind: Record<string, unknown>): void {
  const refs = new Set<string>();
  // Lexical states: 'code' is the only state where @name is a reference.
  let state: 'code' | 'single' | 'double' | 'line' | 'block' = 'code';
  for (let i = 0; i < sql.length; i++) {
    const code = sql.charCodeAt(i);
    switch (state) {
      case 'single':
        if (code === 39 /* ' */) {
          // '' is an escaped quote inside the literal — consume both, stay in.
          if (sql.charCodeAt(i + 1) === 39) i++;
          else state = 'code';
        }
        continue;
      case 'double':
        if (code === 34 /* " */) {
          // "" is an escaped quote inside the identifier — consume both.
          if (sql.charCodeAt(i + 1) === 34) i++;
          else state = 'code';
        }
        continue;
      case 'line':
        if (code === 10 /* \n */) state = 'code';
        continue;
      case 'block':
        // */ closes; * or / alone stay inside the comment.
        if (code === 42 /* * */ && sql.charCodeAt(i + 1) === 47 /* / */) {
          i++;
          state = 'code';
        }
        continue;
      case 'code':
      default: {
        if (code === 39 /* ' */) {
          state = 'single';
          continue;
        }
        if (code === 34 /* " */) {
          state = 'double';
          continue;
        }
        if (code === 45 /* - */ && sql.charCodeAt(i + 1) === 45 /* - */) {
          i++;
          state = 'line';
          continue;
        }
        if (code === 47 /* / */ && sql.charCodeAt(i + 1) === 42 /* * */) {
          i++;
          state = 'block';
          continue;
        }
        if (code === 64 /* @ */) {
          let j = i + 1;
          while (j < sql.length && isIdentCode(sql.charCodeAt(j))) j++;
          // A reference must start with a letter/underscore (@s0, @b12, @vec);
          // a bare '@' or '@9' is prose, not a named parameter.
          const first = sql.charCodeAt(i + 1);
          const startsIdent =
            (first >= 97 && first <= 122) || (first >= 65 && first <= 90) || first === 95;
          if (j > i + 1 && startsIdent) {
            refs.add(sql.slice(i + 1, j));
            i = j - 1;
          }
        }
      }
    }
  }
  const bindKeys = new Set(Object.keys(bind));
  const missing = [...refs].filter((k) => !bindKeys.has(k));
  const extra = [...bindKeys].filter((k) => !refs.has(k));
  if (missing.length > 0 || extra.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing bind keys: ${missing.sort().join(', ')}`);
    if (extra.length > 0) parts.push(`unused bind keys: ${extra.sort().join(', ')}`);
    throw new Error(`[invariant] named-parameter parity broken: ${parts.join('; ')}`);
  }
}
