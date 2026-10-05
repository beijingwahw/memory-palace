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
 * approximation: the overlap tail appended to the next window is joined
 * with single spaces, so the next window's `startChar` may drift by the
 * whitespace difference (a few chars at most), never past the tail's end.
 *
 * Heading handling: a short heading is prepended to the next paragraph
 * chunk so context is preserved without forcing a tiny standalone chunk.
 */

import { approximateTokenCount } from './tokenizer.js';

export interface ChunkOptions {
  /** Target chunk size in tokens (approximate). */
  maxTokens: number;
  /** Overlap between consecutive chunks in tokens. */
  overlapTokens: number;
  /** Don't merge chunks smaller than this; emit as-is. */
  minTokens: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  maxTokens: 256,
  overlapTokens: 32,
  minTokens: 16,
};

const SOFT_SPLIT = /\n{2,}/g;
const SENTENCE_SPLIT = /(?<=[.!?。！？])\s+/g;
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
  //    survives the structural split.
  const merged: Span[] = [];
  for (let i = 0; i < segments.length; i++) {
    const cur = segments[i];
    if (HEADING_ONLY.test(cur.text) && approximateTokenCount(cur.text) < o.minTokens) {
      if (i + 1 < segments.length) {
        const next = segments[i + 1];
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

  const push = (chunkText_: string, start: number, end: number) => {
    const trimmed = chunkText_.trim();
    if (!trimmed) return;
    chunks.push({
      text: trimmed,
      index: index++,
      startChar: start,
      endChar: Math.min(end, text.length),
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
      const candidate = buf ? buf + ' ' + sent.text : sent.text;
      if (approximateTokenCount(candidate) > o.maxTokens && buf) {
        push(buf, bufStart, bufEnd);
        const overlap = tailTokens(buf, o.overlapTokens);
        const sentAbsStart = seg.start + sent.start;
        if (overlap) {
          // The next window begins where the overlap tail begins in the
          // source: at the end of what we just emitted, minus the tail.
          bufStart = Math.max(bufStart, bufEnd - overlap.length);
          buf = overlap + ' ' + sent.text;
        } else {
          bufStart = sentAbsStart;
          buf = sent.text;
        }
        bufEnd = sentAbsStart + sent.text.length;
      } else {
        buf = candidate;
        bufEnd = seg.start + sent.start + sent.text.length;
      }
    }
    if (buf.trim()) push(buf, bufStart, bufEnd);
  }

  return chunks;
}

/**
 * Overlap tail (last `targetTokens` words) seeded into the next window.
 *
 * Invariant: the result is never the whole input — overlap is always
 * strictly smaller than the window it came from, so consecutive windows
 * are guaranteed to make forward progress of at least one word. When the
 * window holds `targetTokens` words or fewer, returning all of them would
 * hand 100% of the previous chunk to the next window (a full-duplicate
 * transition), so the tail is capped at `floor(targetTokens / 2)` words
 * (at least 1, and always one word short of the entire window).
 */
function tailTokens(text: string, targetTokens: number): string {
  const words = text.split(/\s+/);
  if (words.length <= targetTokens) {
    // Strict-progress cap: never the whole text.
    const cap = Math.min(words.length - 1, Math.max(1, Math.floor(targetTokens / 2)));
    return cap > 0 ? words.slice(-cap).join(' ') : '';
  }
  return words.slice(words.length - targetTokens).join(' ');
}
