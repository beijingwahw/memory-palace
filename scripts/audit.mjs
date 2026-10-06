#!/usr/bin/env node
/**
 * Genesis self-audit gate — `npm run audit`.
 *
 * Pure Node, zero dependencies, read-only. Checks the repo invariants that
 * keep the palace's public surfaces synchronized, and exits 1 on ANY
 * violation so CI / prepublish can gate on it.
 *
 * Checks (output is grouped: metadata sync 1–2, source hygiene 3–6,
 * static tripwires 7–11 — each tripwire is the tombstone of one bug
 * class the witch-hunt rounds actually hit):
 *   1. Version triple-sync: package.json === plugin.json === src/types VERSION.
 *   2. Tool-count triple-sync: plugin.json tools === README tool table ===
 *      buildToolDefinitions in src/index.ts.
 *   3. No console.* in src (comment lines exempt; src/bin/ exempt — mirrors
 *      eslint.config.js, where CLI entry points legitimately use console).
 *   4. No `INSERT OR REPLACE INTO memory_items` (tombstone-revival class
 *      antipattern: blind replace resurrects soft-deleted rows).
 *   5. No single-statement `DELETE FROM … ORDER BY … LIMIT` in
 *      memory-store.ts (SQLite-only syntax; the portable subquery form is
 *      allowed). Conservative single-line match — hits are printed with
 *      line numbers for human review; a confirmed false positive can be
 *      exempted with an inline `// audit-ok` on the same line.
 *   6. No `.skip(` (or xit(/xdescribe( prefixes) in test/ (a skipped test
 *      is a silently green gate).
 *   7. No `Math.max(...)` / `Math.min(...)` spread in src/ — every element
 *      becomes a call argument, and a ~125k-element CRDT sync overflowed
 *      the call stack on exactly this shape. Scalar uses (Math.max(0, x))
 *      and reducer folds are fine; comment mentions are exempt (the
 *      check-3 convention: a documented tombstone is not a usage).
 *   8. Exactly one `JSON.parse(` in memory-store.ts — inside safeJson.
 *      A parse anywhere else lets one corrupted cell fail whole-store
 *      reads. Strict textual count; comment or not, the number must be 1.
 *   9. scripts/*.mjs never read the raw pathname property of a URL — on a
 *      checkout path with spaces or non-ASCII segments it is percent-
 *      encoded and keeps a leading slash on Windows, failing every check
 *      with phantom ENOENTs. fileURLToPath is the only sanctioned
 *      primitive; comment mentions are exempt (check-3 convention).
 *  10. Every test/*.test.ts referenced by docs/INVARIANTS.md exists in
 *      the tree — a spec row pointing at a missing file promises a
 *      sentinel that is not on post (spec anti-drift).
 *  11. No bare no-argument stats call in src/index.ts — the tool layer
 *      must count through the scoped variant (facade with a scope, or
 *      the store's statsScoped); a bare call pools every tenant's rows
 *      into one response (cross-tenant observability leak, D-01). The
 *      ONE sanctioned survivor is the facade's own admin-plane
 *      dispatch, marked `// audit-ok` (check-5 convention); bin/ CLI and
 *      service-internal maintenance (compressor / space-migrator) are
 *      outside this check by design. Comment mentions are exempt
 *      (check-3 convention).
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath handles percent-encoded and non-ASCII segments (and never
// leaves a leading slash on Windows): the raw .pathname form broke on any
// checkout path containing spaces or non-ASCII characters, failing every
// check with phantom ENOENTs.
const ROOT = fileURLToPath(new URL('..', import.meta.url));

// ------------------------------------------------------------------ helpers

const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/** Recursively list .ts files under a directory (relative paths). */
function listTsFiles(dirRel) {
  const dirAbs = join(ROOT, dirRel);
  if (!existsSync(dirAbs)) return [];
  const out = [];
  for (const entry of readdirSync(dirAbs)) {
    const abs = join(dirAbs, entry);
    if (statSync(abs).isDirectory()) out.push(...listTsFiles(relative(ROOT, abs)));
    else if (entry.endsWith('.ts')) out.push(relative(ROOT, abs).replace(/\\/g, '/'));
  }
  return out.sort();
}

const results = [];
/** Run one check; record {name, pass, details[]} and print as we go. */
function check(name, fn) {
  const details = [];
  let pass = true;
  try {
    pass = fn(details) !== false;
  } catch (e) {
    pass = false;
    details.push(`check crashed: ${String(e)}`);
  }
  results.push({ name, pass, details });
  console.log(`${pass ? '✔' : '✘'}  ${name}`);
  for (const d of details) console.log(`      ${d}`);
}

let printedAny = false;
/** Print a group label so the ten checks read as three sections. */
function banner(title) {
  if (printedAny) console.log('');
  console.log(`-- ${title} --`);
  printedAny = true;
}

// ------------------------------------------------------------------- checks

banner('metadata sync');

// 1. Version triple-sync -----------------------------------------------------
check('1. version sync: package.json === plugin.json === src/types VERSION', (details) => {
  const pkg = JSON.parse(read('package.json')).version;
  const plugin = JSON.parse(read('plugin.json')).version;
  const m = read('src/types/index.ts').match(/export\s+const\s+VERSION\s*=\s*['"]([^'"]+)['"]/);
  if (!m) {
    details.push('src/types/index.ts: VERSION export not found');
    return false;
  }
  const types = m[1];
  details.push(`package.json=${pkg}  plugin.json=${plugin}  src/types=${types}`);
  return pkg === plugin && pkg === types;
});

// 2. Tool-count triple-sync ---------------------------------------------------
// Counting conventions (deliberately the most stable, unambiguous forms):
//   - README.md: markdown TABLE rows whose first cell is a `memory_*`
//     code span — /^\| *`memory_[a-z0-9_]+`/gm. Prose mentions and code
//     blocks are excluded (they are not table rows).
//   - src/index.ts: occurrences of `name: 'memory_` inside
//     buildToolDefinitions — one per tool definition object literal.
check('2. tool count sync: plugin.json === README table === buildToolDefinitions', (details) => {
  const pluginTools = JSON.parse(read('plugin.json')).tools;
  const readmeRows = read('README.md').match(/^\|\s*`memory_[a-z0-9_]+`/gm) ?? [];
  const srcCount = (read('src/index.ts').match(/name: 'memory_/g) ?? []).length;
  details.push(
    `plugin.json tools=${pluginTools.length}  README table rows=${readmeRows.length}  src/index.ts definitions=${srcCount}`,
  );
  if (pluginTools.length !== readmeRows.length || pluginTools.length !== srcCount) {
    const readmeSet = new Set(readmeRows.map((r) => r.match(/`([^`]+)`/)[1]));
    const onlyPlugin = pluginTools.filter((t) => !readmeSet.has(t));
    const onlyReadme = [...readmeSet].filter((t) => !pluginTools.includes(t));
    if (onlyPlugin.length) details.push(`in plugin.json but not README table: ${onlyPlugin.join(', ')}`);
    if (onlyReadme.length) details.push(`in README table but not plugin.json: ${onlyReadme.join(', ')}`);
    return false;
  }
  return true;
});

// 3. No console.* in src ------------------------------------------------------
banner('source hygiene');
// Mirrors eslint.config.js: `no-console: error` for src/** EXCEPT src/bin/**
// (CLI entry points legitimately write to stdout/stderr). A console.* on a
// line whose preceding text already contains // is a comment — exempt.
check('3. src/ has no console.* (comments and src/bin/ exempt)', (details) => {
  let pass = true;
  for (const file of listTsFiles('src')) {
    if (file.startsWith('src/bin/')) continue;
    const lines = read(file).split('\n');
    lines.forEach((line, i) => {
      let idx = line.indexOf('console.');
      while (idx !== -1) {
        const before = line.slice(0, idx);
        if (!before.includes('//')) {
          details.push(`${file}:${i + 1}: ${line.trim()}`);
          pass = false;
        }
        idx = line.indexOf('console.', idx + 1);
      }
    });
  }
  return pass;
});

// 4. No INSERT OR REPLACE INTO memory_items -----------------------------------
check('4. src/ has no `INSERT OR REPLACE INTO memory_items` (tombstone revival)', (details) => {
  let pass = true;
  for (const file of listTsFiles('src')) {
    read(file).split('\n').forEach((line, i) => {
      if (/INSERT\s+OR\s+REPLACE\s+INTO\s+memory_items/i.test(line)) {
        details.push(`${file}:${i + 1}: ${line.trim()}`);
        pass = false;
      }
    });
  }
  return pass;
});

// 5. No single-statement DELETE … ORDER BY … LIMIT in memory-store.ts ----------
// Portability antipattern: `DELETE FROM t … ORDER BY … LIMIT` is a SQLite
// compile-time-option extension; the portable shape is
// `DELETE FROM t WHERE id IN (SELECT id FROM t … ORDER BY … LIMIT ?)`.
// Conservative single-line match (the subquery form puts ORDER BY on a
// DIFFERENT line than DELETE FROM, so it does not trip). A human-confirmed
// false positive may carry an inline `// audit-ok` on the same line.
check('5. memory-store.ts has no direct `DELETE FROM … ORDER BY … LIMIT`', (details) => {
  let pass = true;
  const file = 'src/services/memory-store.ts';
  read(file).split('\n').forEach((line, i) => {
    if (/DELETE\s+FROM/i.test(line) && /ORDER\s+BY/i.test(line) && /LIMIT/i.test(line)) {
      if (/\/\/\s*audit-ok/.test(line)) {
        details.push(`${file}:${i + 1}: exempted via // audit-ok`);
        return;
      }
      details.push(`${file}:${i + 1}: ${line.trim()}  ← review: subquery form is portable`);
      pass = false;
    }
  });
  return pass;
});

// 6. No .skip( in test/ --------------------------------------------------------
// Also flags the mocha-style xit(/xdescribe( prefixes — a prefixed test is
// the same silently-green gate as a .skip.
check('6. test/ has no `.skip(` or `xit(`/`xdescribe(`', (details) => {
  let pass = true;
  for (const file of listTsFiles('test')) {
    read(file).split('\n').forEach((line, i) => {
      if (line.includes('.skip(') && !line.slice(0, line.indexOf('.skip(')).includes('//')) {
        details.push(`${file}:${i + 1}: ${line.trim()}`);
        pass = false;
      }
      // \b keeps `xit(` from matching inside longer identifiers (e.g.
      // `axit(`); an x-prefixed runner call is never legitimate in this
      // suite, so no comment-exemption nuance is applied.
      const xPrefix = line.search(/\bx(it|describe)\(/);
      if (xPrefix !== -1 && !line.slice(0, xPrefix).includes('//')) {
        details.push(`${file}:${i + 1}: ${line.trim()}`);
        pass = false;
      }
    });
  }
  return pass;
});

// 7. No spread into Math.max/Math.min in src/ --------------------------------
banner('static tripwires (bug-class tombstones)');
// Stack-overflow tombstone: `Math.max(...ops)` materializes every element
// as a call argument — one stack slot each; a ~125k-op CRDT sync died on
// exactly this shape. Scalar uses (Math.max(0, x)) are fine; large folds
// must go through reduce(). `\s*` spans newlines, so a spread pushed to
// the next line still trips. Comment mentions are exempt: the tombstone
// comment in crdt-federation.ts documents the bug, it does not recommit it.
check('7. src/ has no `Math.max(...)`/`Math.min(...)` spread (stack-overflow class)', (details) => {
  let pass = true;
  const re = /Math\.(max|min)\(\s*\.\.\./g;
  for (const file of listTsFiles('src')) {
    const text = read(file);
    let m;
    while ((m = re.exec(text)) !== null) {
      const before = text.slice(0, m.index);
      const lineStart = before.lastIndexOf('\n') + 1;
      if (text.slice(lineStart, m.index).includes('//')) continue; // comment mention
      details.push(`${file}:${before.split('\n').length}: ${m[0].replace(/\s+/g, ' ')}  ← fold with reduce instead`);
      pass = false;
    }
  }
  return pass;
});

// 8. memory-store.ts: exactly one JSON.parse( --------------------------------
// Degraded-read tombstone: safeJson() is the only sanctioned parse point —
// it turns a corrupted cell into a fallback value instead of an exception
// (I-DI-08's execution surface). Any second occurrence of the literal
// `JSON.parse(` — even one individually wrapped in try/catch — fragments
// the degradation policy: the count must stay exactly 1 so that every
// future JSON column decode is forced through the shared helper.
check('8. memory-store.ts has exactly one `JSON.parse(` (inside safeJson)', (details) => {
  const file = 'src/services/memory-store.ts';
  const lines = read(file).split('\n');
  const hitLines = [];
  lines.forEach((line, i) => {
    for (let idx = line.indexOf('JSON.parse('); idx !== -1; idx = line.indexOf('JSON.parse(', idx + 1)) {
      hitLines.push(i + 1);
    }
  });
  if (hitLines.length === 1) {
    details.push(`1 occurrence at line ${hitLines[0]} — the safeJson helper`);
    return true;
  }
  details.push(
    `expected exactly 1 occurrence (inside safeJson), found ${hitLines.length}` +
      (hitLines.length ? ` at line(s) ${hitLines.join(', ')}` : ''),
  );
  details.push('a JSON.parse outside safeJson lets one corrupted cell fail whole-store reads');
  return false;
});

// 9. scripts/*.mjs must not read the raw pathname property of a URL ---------
// Encoding tombstone: on a checkout path containing spaces or non-ASCII
// segments, that property is percent-encoded (and keeps a leading slash on
// Windows) — the gate then fails every check with phantom ENOENTs (this
// repo was bitten as a 3/6 red). fileURLToPath (see ROOT above) is the only
// correct primitive. The pattern below is assembled from two fragments on
// purpose: a single literal would make this check flag its own source.
// Comment mentions are exempt (check-3 convention).
check('9. scripts/ resolves URL paths via fileURLToPath (no raw pathname access)', (details) => {
  let pass = true;
  const rawPathname = new RegExp('\\.' + 'pathname'); // split on purpose — see above
  const scriptsDir = join(ROOT, 'scripts');
  const files = readdirSync(scriptsDir)
    .filter((f) => f.endsWith('.mjs') && statSync(join(scriptsDir, f)).isFile())
    .sort();
  for (const f of files) {
    const rel = `scripts/${f}`;
    read(rel).split('\n').forEach((line, i) => {
      const idx = line.search(rawPathname);
      if (idx !== -1 && !line.slice(0, idx).includes('//')) {
        details.push(`${rel}:${i + 1}: ${line.trim()}  ← use fileURLToPath(new URL(...))`);
        pass = false;
      }
    });
  }
  return pass;
});

// 10. INVARIANTS.md execution points must exist ------------------------------
// Spec-anti-drift: every test/*.test.ts referenced by the invariant catalog
// must exist in the tree. A spec row pointing at a renamed or never-landed
// file is a silently green gate — the catalog promises a sentinel that is
// not on post. Zero extracted references is itself a violation (an emptied
// or mangled spec is not a passing spec).
check('10. INVARIANTS.md test-file references all exist (spec anti-drift)', (details) => {
  const file = 'docs/INVARIANTS.md';
  const text = read(file);
  const refs = [...new Set([...text.matchAll(/test\/[a-z0-9-]+\.test\.ts/g)].map((m) => m[0]))].sort();
  if (refs.length === 0) {
    details.push(`${file}: no test/*.test.ts references extracted — spec emptied or extraction broken`);
    return false;
  }
  const missing = refs.filter((r) => !existsSync(join(ROOT, r)));
  details.push(`${refs.length} unique test file reference(s): ${refs.join(', ')}`);
  for (const ref of missing) details.push(`${file} references missing file: ${ref}`);
  return missing.length === 0;
});

// 11. src/index.ts has no bare no-argument stats call ------------------------
// Cross-tenant leak tombstone (D-01): the request-facing tools live in
// src/index.ts, and a no-argument stats call there returns whole-store
// numbers pooled across EVERY tenant — exactly the observability leak
// scoped statistics exist to close. Tools must count through the scoped
// variant (facade stats WITH a scope argument, or the store's
// statsScoped(level)). Two deliberate exemptions:
//   - the facade's own admin-plane dispatch (stats with no scope IS the
//     documented management contract) carries an inline `// audit-ok`
//     marker — the check-5 convention;
//   - comment mentions document the tombstone, they do not recommit it
//     (the check-3 convention).
// bin/ CLI entry points and service-internal maintenance reads
// (compressor / space-migrator whole-store passes) are outside this
// check's reach BY DESIGN: they are not request-facing.
// Literal pattern, plain and readable: this check reads src/index.ts only
// (never its own source), so unlike check 9 there is no self-match to dodge.
// `\(\)` pins the EMPTY argument list — the no-argument (cross-tenant)
// form; scoped calls pass a scope/level argument and do not match.
const BARE_STATS = /\.stats\(\)/g;
check('11. src/index.ts has no bare no-argument stats call (tools must count scoped)', (details) => {
  let pass = true;
  const file = 'src/index.ts';
  const text = read(file);
  let m;
  while ((m = BARE_STATS.exec(text)) !== null) {
    const before = text.slice(0, m.index);
    const lineStart = before.lastIndexOf('\n') + 1;
    const lineEnd = text.indexOf('\n', m.index);
    const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    const lineNo = before.split('\n').length;
    if (text.slice(lineStart, m.index).includes('//')) {
      details.push(`${file}:${lineNo}: comment mention (exempt)`);
      continue;
    }
    if (/\/\/\s*audit-ok/.test(line)) {
      details.push(`${file}:${lineNo}: exempted via // audit-ok (admin-plane dispatch)`);
      continue;
    }
    details.push(
      `${file}:${lineNo}: ${line.trim()}  ← count through facade stats(scope) / statsScoped(level); a bare call pools every tenant's rows`,
    );
    pass = false;
  }
  if (pass && details.length === 0) details.push('no bare call sites — every tool count is scoped');
  return pass;
});

// ------------------------------------------------------------------- summary

const failed = results.filter((r) => !r.pass);
console.log('');
console.log(`audit: ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log(`FAILED: ${failed.map((r) => r.name).join(' | ')}`);
  process.exit(1);
}
console.log('audit: all green');
process.exit(0);
