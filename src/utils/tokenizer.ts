/**
 * Tokenizer utilities. We use a lightweight word + byte-level approximation
 * that works without any external model. Good enough for token budgeting
 * and BM25-style keyword scoring. For exact token counts, downstream
 * pipelines (the LLM provider) compute their own.
 *
 * CJK text gets overlapping-bigram segmentation: without word boundaries to
 * lean on, a whole CJK run would otherwise be ONE token, invisible to
 * Jaccard overlap, DF statistics and every keyword scorer downstream.
 */

const WORD_RE = /[\p{L}\p{N}_]+/gu;
/** One Han/Hiragana/Katakana character (detection inside a word token). */
const CJK_CHAR_RE = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u;
/** Global variant for counting CJK characters (one match per character). */
const CJK_GLOBAL_RE = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/gu;

/**
 * Approximate token count. The real formula (no hidden coefficients):
 *   words (1 token each) + ceil(non-word chars / 5) + CJK characters
 * where non-word chars are everything WORD_RE does not match
 * (punctuation/whitespace — ~1 token per 5 of them), and every CJK
 * character counts as ~1 token (embedding models segment CJK roughly
 * per character; counting a 50-char Chinese run as one word underbudgets
 * it by 50×).
 */
export function approximateTokenCount(text: string): number {
  if (!text) return 0;
  const words = text.match(WORD_RE);
  const wordCount = words ? words.length : 0;
  const nonWord = text.replace(WORD_RE, '').length;
  // CJK_GLOBAL_RE is /u-flagged, so match() walks code POINTS — an
  // astral-plane Han character (𠀀) counts as one character, never as
  // two surrogate halves.
  const cjk = text.match(CJK_GLOBAL_RE);
  const cjkCount = cjk ? cjk.length : 0;
  return Math.max(1, wordCount + Math.ceil(nonWord / 5) + cjkCount);
}

/**
 * Tokenize into normalized lowercase words, dropping very short tokens.
 *
 * WORD_RE happily matches across script boundaries — "用DeepSeek写RAG系统"
 * is ONE match (every char is \p{L}) — so each match is first split into
 * maximal same-script runs (CJK code points vs. everything else). This is
 * the mixed-script fix: the old per-character walk kept only the CJK
 * characters of such tokens and silently DROPPED every Latin/digit segment
 * ("用deepseek写rag系统" yielded just 用/写/系统 — "deepseek" and "rag"
 * vanished from every keyword index downstream).
 *
 *  - A CJK run becomes overlapping character bigrams ("依赖数据库" →
 *    依赖/赖数/数据/据库); a single-character run keeps its character
 *    (length 1 is allowed for CJK only — at a run boundary an isolated
 *    Han char between Latin segments, e.g. the 写 above, is kept alone).
 *  - A non-CJK run is reassembled into a string and keeps the plain rule:
 *    length ≥ 2, lowercased (already, from the toLowerCase pass).
 *
 * Segmentation runs on CODE POINTS (Array.from), never on UTF-16 code
 * units: astral-plane characters (CJK Extension B/C/D like 𠀀, math
 * alphanumerics like 𝕏, emoji) are surrogate pairs in JS strings, and
 * code-unit indexing would address half a character — at best skipping
 * the character entirely (a lone surrogate has no script, so it fails
 * the CJK test and vanishes from every keyword index downstream), at
 * worst slicing a bigram through the middle of a pair into invalid text.
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const matches = text.toLowerCase().match(WORD_RE);
  if (!matches) return out;
  for (const tok of matches) {
    if (!CJK_CHAR_RE.test(tok)) {
      if (tok.length >= 2) out.push(tok);
      continue;
    }
    // Maximal same-script runs: [i, j) is a contiguous span whose code
    // points all share the same CJK-ness as cps[i].
    const cps = Array.from(tok);
    let i = 0;
    while (i < cps.length) {
      const head = cps[i];
      if (head === undefined) break; // i < cps.length
      const cjk = CJK_CHAR_RE.test(head);
      let j = i + 1;
      while (j < cps.length) {
        const cj = cps[j];
        if (cj === undefined || CJK_CHAR_RE.test(cj) !== cjk) break;
        j++;
      }
      if (cjk) {
        const run = cps.slice(i, j);
        if (run.length === 1) {
          const only = run[0];
          if (only !== undefined) {
            out.push(only); // isolated CJK char: no neighbor to pair with
          }
        } else {
          for (let k = 0; k + 1 < run.length; k++) {
            const a = run[k];
            const b = run[k + 1];
            if (a !== undefined && b !== undefined) out.push(a + b);
          }
        }
      } else {
        // Non-CJK run: the plain ≥ 2 rule (UTF-16 length — an astral
        // single char like 𝕏 has length 2 and stays eligible).
        const run = cps.slice(i, j).join('');
        if (run.length >= 2) out.push(run);
      }
      i = j;
    }
  }
  return out;
}

/**
 * Truncate a string to at most `n` CODE POINTS total, ellipsis included —
 * the same code-point discipline tokenize follows. The old UTF-16 slice
 * could cut through a surrogate pair (emoji, CJK Extension B characters),
 * leaving a lone surrogate before the '…' (invalid text downstream).
 * n <= 0 returns '' (there is no room for even the ellipsis); otherwise an
 * overlong input yields its first n−1 code points plus '…'.
 */
export function truncateText(s: string, n: number): string {
  if (n <= 0) return '';
  const cps = Array.from(s);
  if (cps.length <= n) return s;
  return cps.slice(0, n - 1).join('') + '…';
}

/** Truncate text to approximately N tokens by word boundaries. */
export function truncateToTokens(text: string, maxTokens: number): string {
  const tokens = tokenize(text);
  if (tokens.length <= maxTokens) return text;
  return tokens.slice(0, maxTokens).join(' ') + '…';
}
