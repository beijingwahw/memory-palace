/**
 * Tokenizer utilities. We use a lightweight word + byte-level approximation
 * that works without any external model. Good enough for token budgeting
 * and BM25-style keyword scoring. For exact token counts, downstream
 * pipelines (the LLM provider) compute their own.
 */

const WORD_RE = /[\p{L}\p{N}_]+/gu;

/** Approximate token count: words + punctuation groups, ~0.75 words per token. */
export function approximateTokenCount(text: string): number {
  if (!text) return 0;
  const words = text.match(WORD_RE);
  const wordCount = words ? words.length : 0;
  const nonWord = text.replace(WORD_RE, '').length;
  // roughly: words = tokens, plus 1 token per ~4 punctuation chars
  return Math.max(1, wordCount + Math.ceil(nonWord / 5));
}

/** Tokenize into normalized lowercase words, dropping very short tokens. */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const matches = text.toLowerCase().match(WORD_RE);
  if (!matches) return out;
  for (const tok of matches) {
    if (tok.length >= 2) out.push(tok);
  }
  return out;
}

/** Truncate a string to at most `n` chars, appending an ellipsis. */
export function truncateText(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}

/** Truncate text to approximately N tokens by word boundaries. */
export function truncateToTokens(text: string, maxTokens: number): string {
  const tokens = tokenize(text);
  if (tokens.length <= maxTokens) return text;
  return tokens.slice(0, maxTokens).join(' ') + '…';
}
