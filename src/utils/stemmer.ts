/**
 * Lightweight deterministic stemmer — retrieval-time lexical folding.
 *
 * A minimal Porter-spirit suffix-stripping subset that folds high-frequency
 * English inflections (deploy ↔ deploys/deploys ↔ deployed, run ↔ running,
 * studies → study) so the keyword rerank stage can match "how does aurora
 * deploy?" against content that says "deploys". This is the zero-LLM route
 * to lifting the vocabulary-miss ceiling of raw-token lexical matching.
 *
 * SCOPE — RETRIEVAL-TIME MATCHING ONLY, never an embedding input (I-NT-12):
 * stem() folds tokens at MATCH time (comparing two already-produced token
 * lists). It must NOT be wired into tokenize() or into any embedding text
 * path — sparse/hash embedding spaces are stable precisely because every
 * text passes through the SAME unstemmed vocabulary; feeding folded tokens
 * into one side would silently change the meaning of every stored vector.
 * The offline BM25 hashing and the token budget likewise stay raw-domain.
 *
 * FOLDING CONSISTENCY OVER LINGUISTIC PRECISION: there is no exception
 * dictionary, so a few over/under-foldings are accepted on purpose —
 * `movies → movy` (which then fails to meet `movie` itself) is the
 * canonical example, and unguarded strips like `kubernetes → kubernete`
 * are equally lopsided but harmless. The contract is only that BOTH
 * sides of a comparison fold through the same deterministic rules, so
 * "databases" in a query matches "database"/"databases" in content.
 * Chasing linguistic exactness (irregulars, e-restoration, exception
 * lists) buys little recall and costs review surface.
 *
 * Inputs are assumed pre-lowercased (tokenize() lowercases); CJK and other
 * non-Latin tokens are returned unchanged (their "inflection" is not
 * suffixal, and CJK bigrams must survive verbatim). All rules are pure
 * string functions of the token — no state, no locale, no RNG.
 */

/**
 * Ruleset identity for the folding rules below. Embedded in the retriever's
 * query-cache paramsKey: stem folding is a MATCH-time behavior that changes
 * which items a query matches WITHOUT touching the store's dataVersion, so
 * a future rules change (or a rollback) would otherwise serve cache entries
 * scored under the other ruleset — a silent cross-answers class. Bump this
 * constant whenever a rule is added, removed, or re-ordered in a way that
 * changes any fold outcome.
 */
export const STEM_RULESET_VERSION = 1;

/** One Han/Hiragana/Katakana code point anywhere in the token. */
const CJK_RE = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u;

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);

/**
 * Ordered suffix rules (first match wins; endings are mutually exclusive
 * by final letter except within the s-family, where ies/sses must run
 * before the bare-s strip):
 *
 * | # | rule        | guard                                        | example            |
 * |---|-------------|----------------------------------------------|--------------------|
 * | 1 | ies → y     | len > 4                                      | studies → study    |
 * | 2 | sses → ss   | len > 4                                      | classes → class    |
 * | 3 | s → ∅       | len > 3 and not ending ss/us/is              | deploys → deploy   |
 * | 4 | ing → ∅     | len > 5; remainder < 3 keeps the original    | running → run      |
 * |   |             | then undouble a final doubled consonant      |                    |
 * |   |             | ∉ {l, s, z} (Porter: fall/spell/process stay)|                    |
 * | 5 | ed → ∅      | len > 5; same remainder + undoubling rules   | deployed → deploy  |
 * | 6 | ly → ∅      | len > 4 and the char before "ly" is a        | quickly → quick    |
 * |   |             | consonant (family stays — protects the       |                    |
 * |   |             | ies→y fold family ↔ families)                |                    |
 *
 * The undoubling in rules 4/5 is what makes running ↔ run fold (runn →
 * run) while falling ↔ fall keeps folding (ll is excluded, so both sides
 * keep "fall"). Non-Latin scripts never match the ASCII suffixes; CJK is
 * additionally short-circuited up front.
 */
export function stem(token: string): string {
  if (token.length < 3 || CJK_RE.test(token)) return token;

  // Rule 1: ies → y.
  if (token.length > 4 && token.endsWith('ies')) {
    return token.slice(0, -3) + 'y';
  }
  // Rule 2: sses → ss.
  if (token.length > 4 && token.endsWith('sses')) {
    return token.slice(0, -2);
  }
  // Rule 3: bare trailing s (genitive/plural/3rd-person), guarded so
  // ss/us/is endings keep their s ("class", "focus", "basis" — and the
  // pronoun-ish "its"/"was" are protected by the len > 3 guard).
  if (
    token.endsWith('s') &&
    token.length > 3 &&
    !token.endsWith('ss') &&
    !token.endsWith('us') &&
    !token.endsWith('is')
  ) {
    return token.slice(0, -1);
  }
  // Rules 4/5: gerund/past-participle -ing and past-tense -ed. If the
  // remainder would be shorter than 3 chars the strip is refused (the
  // original token is kept) — that guard is about never producing a
  // degenerate 1–2 char stem, not about any particular word.
  if (token.length > 5 && (token.endsWith('ing') || token.endsWith('ed'))) {
    const base = token.slice(0, token.endsWith('ing') ? -3 : -2);
    if (base.length < 3) return token;
    return undoubleFinalConsonant(base);
  }
  // Rule 6: adverbial -ly, only when preceded by a consonant ("quickly" →
  // "quick" but "family" keeps its ly so that families → family still
  // folds with it; vowel-guard chosen over a dictionary of -ly nouns).
  if (token.length > 4 && token.endsWith('ly')) {
    const before = token.slice(-3, -2);
    if (before !== '' && !VOWELS.has(before)) return token.slice(0, -2);
    return token;
  }
  return token;
}

/** stem() over a whole token list, order- and multiplicity-preserving. */
export function stemAll(tokens: string[]): string[] {
  return tokens.map(stem);
}

/**
 * Porter's post-strip undoubling: a remainder ending in a doubled
 * consonant other than l/s/z loses one copy ("runn" → "run") — that is
 * the doubling English orthography adds when -ing/-ed attaches to a short
 * verb. l/s/z are excluded because "fall"/"spell"/"process" legitimately
 * end doubled and must keep folding with their inflections
 * (falling → fall, spelling → spell, processing → process).
 */
function undoubleFinalConsonant(base: string): string {
  const last = base.slice(-1);
  const secondLast = base.slice(-2, -1);
  if (
    base.length >= 3 &&
    last !== '' &&
    secondLast === last &&
    !VOWELS.has(last) &&
    last !== 'l' &&
    last !== 's' &&
    last !== 'z'
  ) {
    return base.slice(0, -1);
  }
  return base;
}

/**
 * Stem-domain second-pass exclusion for PRF expansion tokens.
 *
 * `expansionTokens()` (utils/prf.ts) drops candidate terms that appear
 * VERBATIM in the query's token list — a raw-domain exclusion. Inflectional
 * variants survive it: for the query "deploy aurora", a hit document saying
 * "deploys" yields the expansion term "deploys", which the raw exclusion
 * keeps and the (stem-domain) keyword stage then double-counts as fresh
 * evidence. This helper drops any candidate whose STEM falls inside the
 * query's stem set — apply it to expansionTokens() output before the terms
 * feed keyword-stage emphasis:
 *
 *   excludingQueryStems(expansionTokens(queryTokens, hitLists), queryTokens)
 *
 * Shipped as a pure helper next to the rules (rather than inside prf.ts,
 * whose raw-domain exclusion is a separate concern): grep shows
 * expansionTokens currently has no in-pipeline runtime call site — it is a
 * publicly exported utility for keyword-stage emphasis consumers — so the
 * filter lands where the stem vocabulary lives, ready for that call site.
 */
export function excludingQueryStems(
  candidates: string[],
  queryTokens: string[],
): string[] {
  const queryStems = new Set(stemAll(queryTokens));
  return candidates.filter((t) => !queryStems.has(stem(t)));
}
