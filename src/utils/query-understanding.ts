/**
 * Query understanding — zero-LLM "self-query retrieval".
 *
 * Production self-query pipelines call an LLM to rewrite a natural
 * question into structured filters. For a local memory plugin that is
 * overkill: a compact, deterministic grammar extracts the high-value
 * signals directly — temporal windows, emphasized phrases and explicit
 * result-size requests — in English and Chinese. The output feeds
 * retrieval as time-range pushdown, keyword emphasis and topK.
 *
 * Everything here is pure: same input → same output, no clock reads
 * except the injectable `now`.
 */

export interface QueryHints {
  /** Only memories created at/after this unix-ms timestamp. */
  sinceMs?: number;
  /** Only memories created at/before this unix-ms timestamp. */
  untilMs?: number;
  /** Explicit result-size request ("top 20", "前 5 条"). */
  topK?: number;
  /** Quoted phrases worth emphasizing during keyword rerank. */
  phrases: string[];
  /** A recency idiom was present (heuristics chose the window). */
  wantsRecent: boolean;
}

const DAY = 86_400_000;

/**
 * Ordered rules; first match wins (most-specific first so "last 3 weeks"
 * beats an incidental "recently" later in the sentence).
 */
const RULES: Array<{
  re: RegExp;
  window: (m: RegExpMatchArray) => { sinceDays?: number; untilDays?: number; markRecent?: boolean };
}> = [
  {
    re: /(?:last|past)\s+(\d+)\s+(day|week|month)s?/i,
    window: (m) => {
      const n = Math.min(365, Math.max(1, Number(m[1])));
      const mult = m[2].toLowerCase() === 'day' ? 1 : m[2].toLowerCase() === 'week' ? 7 : 30;
      return { sinceDays: -n * mult, markRecent: true };
    },
  },
  {
    re: /(?:最?近|过去)\s*(\d+)\s*(天|日|周|个?月)/,
    window: (m) => {
      const n = Math.min(365, Math.max(1, Number(m[1])));
      const mult = /天|日/.test(m[2]) ? 1 : /周/.test(m[2]) ? 7 : 30;
      return { sinceDays: -n * mult, markRecent: true };
    },
  },
  {
    re: /yesterday|昨天/,
    window: () => ({ sinceDays: -2, untilDays: -0.5 }),
  },
  {
    re: /today|今天|今天早上/,
    window: () => ({ sinceDays: -1, markRecent: true }),
  },
  /**
   * Guarded idiom rules. The English branches carry negative lookaheads so
   * adjective/derivative forms never leak a window into an unrelated query:
   *
   * - `last\s+week(?!ly|s\b)` — "the last weekly report", "last weeks"
   *   must NOT open a window; bare "last week" must.
   * - `this\s+week(?!ly)` — "this weekly sync" must NOT open a window.
   * - `last\s+month(?!ly|s\b)` — "last monthly summary" must NOT open a
   *   window.
   *
   * Regression guard set (locked in test/query-understanding.test.ts):
   * no window for "the last weekly report", "this weekly sync",
   * "last monthly summary"; window required for "what did we decide last
   * week", "this week progress", "上个月的部署", "最近 3 天".
   */
  {
    re: /this\s+week(?!ly)|本周|这周|这一周/,
    window: () => ({ sinceDays: -7, markRecent: true }),
  },
  {
    re: /last\s+week(?!ly|s\b)|上周/,
    window: () => ({ sinceDays: -14, untilDays: -7 }),
  },
  {
    re: /last\s+month(?!ly|s\b)|上个月|上月/,
    window: () => ({ sinceDays: -62, untilDays: -31 }),
  },
  {
    re: /recently|lately|最近|近期|刚刚/,
    window: () => ({ sinceDays: -7, markRecent: true }),
  },
];

const TOPK_RE = /(?:top\s+(\d+)|前\s*(\d+)\s*条?)/i;
const PHRASE_RE = /"([^"]{2,80})"|“([^”]{2,80})”/g;

/** Extract structured retrieval hints from a natural-language query. */
export function parseQueryHints(query: string, now: number = Date.now()): QueryHints {
  const hints: QueryHints = { phrases: [], wantsRecent: false };

  for (const rule of RULES) {
    const m = query.match(rule.re);
    if (m) {
      const w = rule.window(m);
      if (w.sinceDays !== undefined) hints.sinceMs = Math.round(now + w.sinceDays * DAY);
      if (w.untilDays !== undefined) hints.untilMs = Math.round(now + w.untilDays * DAY);
      if (w.markRecent) hints.wantsRecent = true;
      break; // first (most specific) temporal match wins
    }
  }

  const topk = query.match(TOPK_RE);
  if (topk) {
    const n = Number(topk[1] ?? topk[2]);
    if (Number.isFinite(n)) hints.topK = Math.min(50, Math.max(1, Math.round(n)));
  }

  PHRASE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PHRASE_RE.exec(query))) {
    const phrase = (m[1] ?? m[2] ?? '').trim();
    if (phrase) hints.phrases.push(phrase);
  }

  return hints;
}
