/**
 * Text chunking with semantic-boundary awareness.
 *
 * Strategy: paragraph → sentence → window. We never split mid-word and we
 * respect hard separators (markdown headings, horizontal rules, code
 * fences) as chunk boundaries. Each chunk carries overlap so retrieval
 * doesn't lose context at chunk seams.
 *
 * ## Boundaries (fence-state machine)
 *
 * Regexes cannot tell an opening ``` from a closing ```, so hard
 * boundaries are computed by a small line scanner that tracks whether it
 * is inside a fenced code block: a boundary is placed BEFORE every
 * heading / rule / fence line, and AFTER every closing fence line. This
 * keeps code blocks intact AND separates them from the prose that
 * follows.
 *
 * ## Exact source positions
 *
 * `startChar` / `endChar` refer to positions in the ORIGINAL text. They
 * are derived from real scanner offsets (not from separator-length
 * guesses), so `text.slice(startChar, endChar)` is the source span of the
 * chunk up to whitespace normalization inside the chunk. The one
 * approximation: when a window packs SEVERAL sentences they are joined
 * with single spaces, so a later window's `startChar` may drift by the
 * whitespace difference (a few chars at most), never past the tail's end.
 * The overlap tail itself is taken from the SOURCE span and glued with
 * the source separator that followed it, so single-sentence windows
 * reproduce the source verbatim.
 *
 * ## Fenced code
 *
 * Fence spans are exempt from sentence packing: code comments routinely
 * contain `。！？` / `. ` sequences that no sentence grammar should act on
 * (the zero-width CJK split once cut a window into the middle of a code
 * line's comment). Oversized fence spans are windowed on LINE boundaries
 * instead — lines accumulate until the next line would bust `maxTokens`,
 * then the window flushes whole lines only.
 *
 * ## The maxTokens floor
 *
 * When a single sentence (or fence line) is ITSELF over budget, no
 * boundary can shrink it, so it is hard-windowed by CODE POINTS into
 * pieces of at most `maxTokens` approximate tokens each — the window
 * fallback the docstring always promised.
 *
 * Heading handling: a short heading is prepended to the next paragraph
 * chunk so context is preserved without forcing a tiny standalone chunk.
 */

import { approximateTokenCount } from './tokenizer.js';

export interface ChunkOptions {
  /** Target chunk size in tokens (approximate). */
  maxTokens: number;
  /**
   * Overlap between consecutive chunks, in CODE POINTS — the last
   * `min(overlapTokens, floor(windowCodePoints / 2))` code points of the
   * previous window seed the next one. Code points, not whitespace words:
   * no-space CJK text is ONE whitespace word, and a word-counted overlap
   * on it degenerated to near-100% duplication between consecutive
   * windows (measured 8.9× write amplification). The half-window cap
   * keeps the overlap strictly smaller than the window it came from, so
   * consecutive windows always make forward progress.
   */
  overlapTokens: number;
  /** Paragraphs smaller than this many tokens are dropped (not emitted). */
  minTokens: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  maxTokens: 256,
  overlapTokens: 32,
  minTokens: 16,
};

const SOFT_SPLIT = /\n{2,}/g;
/**
 * Sentence boundaries. Two branches by script:
 *
 *  - ASCII `.!?` must be followed by whitespace or end-of-text — that
 *    requirement (not just the punctuation) keeps decimals like "3.14"
 *    and dotted abbreviations intact, and allowing `$` (not only `\s+`)
 *    means a text ending straight after its punctuation still yields its
 *    final sentence instead of gluing it to the previous window.
 *  - CJK terminals `。！？` are unambiguous sentence enders (no decimal or
 *    abbreviation use in Han text), and Chinese prose does NOT put a
 *    space after them — requiring `\s` there would collapse an entire
 *    no-space paragraph into ONE "sentence" and defeat maxTokens
 *    windowing, so they split as zero-width matches unconditionally.
 *
 * The zero-width CJK matches are matchAll-safe: its iterator advances
 * lastIndex past empty matches (AdvanceStringIndex in the spec), so
 * there is no infinite loop and no match is skipped.
 */
const SENTENCE_SPLIT = /(?<=[.!?])(?:\s+|$)|(?<=[。！？])/g;
const HEADING_ONLY = /^#{1,6}\s+\S/;
const BOUNDARY_LINE = /^(?:#{1,6}\s|\*\*\*|---|```)/;

export interface Chunk {
  text: string;
  index: number;
  startChar: number;
  endChar: number;
  tokens: number;
}

interface Span {
  text: string;
  start: number;
}

/** Split into top-level spans at markdown structural boundaries. */
function hardSpans(text: string): Span[] {
  const cuts: number[] = [];
  let inFence = false;
  let lineStart = 0;
  while (lineStart <= text.length) {
    const nl = text.indexOf('\n', lineStart);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(lineStart, lineEnd);
    if (!inFence) {
      if (BOUNDARY_LINE.test(line) && lineStart > 0) cuts.push(lineStart);
      if (line.startsWith('```')) inFence = true;
    } else if (line.trim() === '```') {
      inFence = false;
      // cut AFTER the closing fence line (before the newline that ends it)
      if (lineEnd < text.length) cuts.push(lineEnd + 1);
    }
    if (nl === -1) break;
    lineStart = nl + 1;
  }

  const spans: Span[] = [];
  let prev = 0;
  for (const cut of cuts) {
    if (cut > prev) spans.push({ text: text.slice(prev, cut), start: prev });
    prev = cut;
  }
  if (prev < text.length) spans.push({ text: text.slice(prev), start: prev });
  return spans;
}

/** Split a span on blank lines, keeping true offsets. */
function softSpans(span: Span): Span[] {
  const out: Span[] = [];
  let prev = 0;
  for (const m of span.text.matchAll(SOFT_SPLIT)) {
    const piece = span.text.slice(prev, m.index);
    if (piece.trim()) out.push(trimmedSpan(piece, span.start + prev));
    prev = m.index + m[0].length;
  }
  const last = span.text.slice(prev);
  if (last.trim()) out.push(trimmedSpan(last, span.start + prev));
  return out;
}

/** Trim whitespace but keep the offset of the first non-ws character. */
function trimmedSpan(s: string, start: number): Span {
  const lead = s.length - s.trimStart().length;
  return { text: s.trim(), start: start + lead };
}

export function chunkText(text: string, opts: Partial<ChunkOptions> = {}): Chunk[] {
  const o: ChunkOptions = { ...DEFAULT_CHUNK_OPTIONS, ...opts };
  if (!text || !text.trim()) return [];

  // 1. Hard-split on markdown structural boundaries (fence-aware)
  const segments: Span[] = [];
  for (const hard of hardSpans(text)) {
    segments.push(...softSpans(hard));
  }

  // 2. Merge short headings with their following paragraph so context
  //    survives the structural split. A fence span is never merged into:
  //    it must stay line-addressable for fence windowing (below).
  const isFenceSpan = (s: Span) => s.text.startsWith('```');
  const merged: Span[] = [];
  for (let i = 0; i < segments.length; i++) {
    const cur = segments[i];
    if (cur === undefined) continue; // i < segments.length
    if (HEADING_ONLY.test(cur.text) && approximateTokenCount(cur.text) < o.minTokens) {
      const next = i + 1 < segments.length ? segments[i + 1] : undefined;
      if (next !== undefined && !isFenceSpan(next)) {
        merged.push({
          text: `${cur.text}\n\n${next.text}`,
          start: cur.start,
        });
        i += 1;
      } else {
        merged.push(cur);
      }
    } else {
      merged.push(cur);
    }
  }

  // 3. Build chunks, splitting oversized segments by sentence
  const chunks: Chunk[] = [];
  let index = 0;

  // push() trims the window and shifts the offsets so they keep pointing
  // at the first/last non-whitespace character of what is emitted.
  const push = (chunkText_: string, start: number, end: number) => {
    const lead = chunkText_.length - chunkText_.trimStart().length;
    const trail = chunkText_.length - chunkText_.trimEnd().length;
    const trimmed = chunkText_.trim();
    if (!trimmed) return;
    chunks.push({
      text: trimmed,
      index: index++,
      startChar: start + lead,
      endChar: Math.max(start + lead, Math.min(end, text.length) - trail),
      tokens: approximateTokenCount(trimmed),
    });
  };

  for (const seg of merged) {
    const segTokens = approximateTokenCount(seg.text);
    if (segTokens <= o.maxTokens) {
      if (segTokens >= o.minTokens) {
        push(seg.text, seg.start, seg.start + seg.text.length);
      }
      continue;
    }

    // FENCE EXEMPTION: an oversized fenced code block never goes through
    // sentence packing (its '.'/。！？ are code, not prose); it windows on
    // line boundaries instead.
    if (isFenceSpan(seg)) {
      emitFenceByLines(seg, o, push);
      continue;
    }

    // Sentence packing with true source offsets. `bufStart`/`bufEnd`
    // track where the current window's first/last sentence sit in the
    // source segment.
    const sentences: Span[] = [];
    let cursor = 0;
    for (const m of seg.text.matchAll(SENTENCE_SPLIT)) {
      const piece = seg.text.slice(cursor, m.index);
      if (piece.trim()) sentences.push(trimmedSpan(piece, cursor));
      cursor = m.index + m[0].length;
    }
    const tail = seg.text.slice(cursor);
    if (tail.trim()) sentences.push(trimmedSpan(tail, cursor));

    let buf = '';
    let bufStart = seg.start;
    let bufEnd = bufStart;
    for (const sent of sentences) {
      const sentAbsStart = seg.start + sent.start;
      const sentAbsEnd = sentAbsStart + sent.text.length;
      const candidate = buf ? buf + ' ' + sent.text : sent.text;
      if (approximateTokenCount(candidate) > o.maxTokens && buf) {
        push(buf, bufStart, bufEnd);
        // The overlap tail is cut from the SOURCE span (not from the
        // space-joined buffer), so the next window's offsets stay exact.
        const overlap = tailTokens(
          seg.text.slice(bufStart - seg.start, bufEnd - seg.start),
          o.overlapTokens,
        );
        if (overlap) {
          // The next window begins where the overlap tail begins in the
          // source: at the end of what we just emitted, minus the tail.
          bufStart = Math.max(bufStart, bufEnd - overlap.length);
          // Glue with the separator that ACTUALLY sits in the source
          // between the tail and the next sentence ('' for no-space CJK).
          const between = seg.text.slice(bufEnd - seg.start, sent.start);
          buf = overlap + between + sent.text;
        } else {
          bufStart = sentAbsStart;
          buf = sent.text;
        }
        bufEnd = sentAbsEnd;
      } else {
        const hadBuf = buf !== '';
        buf = candidate;
        if (!hadBuf) bufStart = sentAbsStart;
        bufEnd = sentAbsEnd;
      }
      // maxTokens floor: a single sentence over budget has no boundary to
      // save it — hard-window it by code points, emit every head window,
      // and keep the last piece as the buffer so later sentences still
      // pack onto it.
      if (approximateTokenCount(buf) > o.maxTokens) {
        const wins = hardWindowsByCodePoints(sent.text, o.maxTokens);
        if (wins.length > 1) {
          let u16 = 0;
          for (let w = 0; w < wins.length; w++) {
            const win = wins[w];
            if (win === undefined) continue; // w < wins.length
            const absStart = sentAbsStart + u16;
            u16 += win.text.length;
            if (w + 1 < wins.length) push(win.text, absStart, sentAbsStart + u16);
            else {
              buf = win.text;
              bufStart = absStart;
              bufEnd = sentAbsStart + u16;
            }
          }
        }
      }
    }
    if (buf.trim()) push(buf, bufStart, bufEnd);
  }

  return chunks;
}

/** Accumulate a fenced-code span into whole-line windows. */
function emitFenceByLines(
  seg: Span,
  o: ChunkOptions,
  push: (chunkText_: string, start: number, end: number) => void,
): void {
  const lines = seg.text.split('\n');
  let buf: string[] = [];
  let winStart = seg.start; // absolute start of the current line window
  let prevLineEnd = seg.start; // absolute end of the last line taken into buf
  let cursor = seg.start; // absolute start of the current line
  for (const line of lines) {
    const lineStart = cursor;
    const lineEnd = lineStart + line.length;
    cursor = lineEnd + 1; // past this line's newline (if any)
    const candidate = buf.length ? buf.join('\n') + '\n' + line : line;
    if (buf.length && approximateTokenCount(candidate) > o.maxTokens) {
      push(buf.join('\n'), winStart, prevLineEnd);
      winStart = lineStart;
      buf = [line];
    } else {
      buf.push(line);
    }
    const head = buf[0];
    if (head !== undefined && buf.length === 1 && approximateTokenCount(head) > o.maxTokens) {
      // One line alone busts the budget: hard code-point windows (the
      // last-resort fallback; still never applies sentence grammar).
      const wins = hardWindowsByCodePoints(head, o.maxTokens);
      if (wins.length > 1) {
        let u16 = 0;
        for (const win of wins) {
          const absStart = lineStart + u16;
          u16 += win.text.length;
          push(win.text, absStart, lineStart + u16);
        }
        buf = [];
        winStart = cursor;
      }
    }
    prevLineEnd = lineEnd;
  }
  if (buf.length && buf.join('\n').trim()) {
    push(buf.join('\n'), winStart, seg.start + seg.text.length);
  }
}

/**
 * Hard-window `text` by CODE POINTS into pieces of at most `maxTokens`
 * approximate tokens each. approximateTokenCount is monotone
 * non-decreasing as the window extends (appending characters can only add
 * words / non-word chars / CJK chars), so a binary search finds the
 * largest fitting end per window in O(log n) counts, and every window is
 * guaranteed non-empty (≥ 1 code point) — strict forward progress holds
 * even for pathological inputs (e.g. 600 consecutive Han characters).
 */
function hardWindowsByCodePoints(text: string, maxTokens: number): Array<{ text: string }> {
  const cps = Array.from(text);
  const out: Array<{ text: string }> = [];
  let i = 0;
  while (i < cps.length) {
    let lo = i + 1; // at least one code point per window (progress)
    let hi = cps.length;
    while (lo < hi) {
      const mid = lo + ((hi - lo + 1) >> 1);
      if (approximateTokenCount(cps.slice(i, mid).join('')) <= maxTokens) lo = mid;
      else hi = mid - 1;
    }
    out.push({ text: cps.slice(i, lo).join('') });
    i = lo;
  }
  return out;
}

/**
 * Overlap tail (last `targetTokens` CODE POINTS) seeded into the next
 * window.
 *
 * The unit is the code point, not the whitespace word: no-space CJK text
 * is a single \s+ word, so a word-counted tail on it would hand (nearly)
 * the whole window to the next chunk — near-verbatim duplicate chunks and
 * an 8.9× write amplification on ingest. The tail is capped at
 * `floor(codePoints / 2)` of the window it came from, so it is always
 * strictly smaller than that window and consecutive windows are
 * guaranteed to make forward progress of at least one code point (a
 * 1-code-point window yields an empty tail, i.e. no overlap at all).
 */
function tailTokens(text: string, targetTokens: number): string {
  const cps = Array.from(text);
  const take = Math.min(Math.max(0, targetTokens), Math.floor(cps.length / 2));
  if (take <= 0) return '';
  return cps.slice(cps.length - take).join('');
}
