/**
 * ANONYMOUS-WRITE POLICY — the explicit tri-state (global | quarantine |
 * reject) that replaced the old implicit "no id at all → global bucket"
 * fail-open.
 *
 * Decision matrix, proven at the REAL plugin boundary (full install with
 * the mock Cordis context, offline-bm25 embeddings, a throwaway database
 * per subtest):
 *
 *   A  default 'global'   — anonymous message lands visibility='global'
 *                           (current-behavior lock: the default must be
 *                           byte-equivalent to the pre-policy world).
 *   B  'quarantine'       — anonymous message lands visibility='session'
 *                           with session_id='__anonymous__'; an
 *                           identified user retrieves ZERO of it; the
 *                           anonymous-bucket caller retrieves its own
 *                           writes back (self-consistency); identified
 *                           writes are untouched by the policy.
 *   C  'reject'           — anonymous message is dropped: handler does
 *                           NOT crash, the store keeps ZERO rows, and a
 *                           logger.warn is recorded; identified messages
 *                           ingest normally.
 *   D  session.end        — 'quarantine': an anonymous session.end sends
 *                           every sleep-stage write into the isolation
 *                           bucket (stratifier digests spot-checked);
 *                           'reject': the sleep is skipped with a warn
 *                           and nothing explodes, while an identified
 *                           session.end still sleeps.
 *   E  install validation — a non-tri-state policy value throws AT
 *                           INSTALL, listing the legal values.
 *
 * Determinism: no randomness feeds the assertions — fixed contents,
 * offline (hash-based, deterministic) embeddings, one fresh database per
 * subtest, and handlers are driven DIRECTLY (awaited, not raced through
 * ctx.emit). The Windows WAL close-before-rm hook discipline is copied
 * from integration.test.ts: the store-close hook is registered BEFORE
 * freshDb registers the tmpdir removal, because t.after hooks run in
 * registration order and rmSync cannot remove a directory holding an
 * open better-sqlite3 handle.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import MemoryPalacePlugin from '../src/index.ts';
import { createMockContext, type MockContext } from './mock-context.ts';
import { ANONYMOUS_SESSION_ID } from '../src/utils/scope.ts';
import type { CordisEvent } from '../src/types/cordis.ts';

/** Marker-bearing anonymous payload: long enough to clear the chunker's
 *  16-token semantic-candidate gate, distinctive enough that offline-bm25
 *  retrieval locks onto it. */
const ANON_CONTENT =
  'QuarantineMarker Zephyr runs the nightly ledger reconciliation against ' +
  'the Aurora warehouse and posts the computed deltas to the OpsBridge ' +
  'channel so the on-call rotation can review them every morning shift.';

const ANON_QUERY = 'QuarantineMarker Zephyr nightly ledger reconciliation';

/** Minimal structural handle for registering cleanup on a (sub)test. */
interface AfterHooks {
  after: (fn: () => void) => void;
}

/** A brand-new temporary database path, cleaned up after the subtest. */
const freshDb = (t: AfterHooks): string => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-anon-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'memory.db');
};

/**
 * Install the plugin against a fresh, subtest-private database.
 *
 * Hook ORDER is the whole game on Windows: the store close must be
 * registered BEFORE freshDb's tmpdir rm (hooks run in registration
 * order), or rmSync hits the open WAL handle (EPERM). ctx is created up
 * front so the close hook can capture it directly.
 */
const install = (t: AfterHooks, opts: Record<string, unknown> = {}): MockContext => {
  const ctx = createMockContext();
  t.after(() => {
    const store = ctx.services.get('memory-store') as { close(): void } | undefined;
    try {
      store?.close();
    } catch {
      // store already closed — nothing to do
    }
  });
  const dbPath = freshDb(t);
  MemoryPalacePlugin(ctx as never, {
    storagePath: dbPath,
    embedding: { provider: 'offline-bm25', model: 'bm25', dimensions: 256 },
    ...opts,
  });
  return ctx;
};

/**
 * Drive ONE registered event handler directly and await it — unlike
 * ctx.emit (fire-and-forget in the mock), this makes every store write
 * deterministic with respect to the assertions that follow.
 */
const fire = async (ctx: MockContext, name: string, event: CordisEvent): Promise<void> => {
  const handlers = ctx.handlers.get(name) ?? [];
  assert.ok(handlers.length > 0, `${name} handler registered`);
  for (const h of handlers) await h(event);
};

/** Anonymous event: no ids anywhere (sessionId '' + empty payload scope). */
const anonEvent = (content: string): CordisEvent => ({
  sessionId: '',
  payload: { content },
});

const palaceOf = (ctx: MockContext) => ctx.services.get('memory-palace') as any;

const semanticItems = (ctx: MockContext) =>
  palaceOf(ctx).store.listItemsByLayer('semantic', 500) as Array<{
    content: string;
    visibility?: string;
    sessionId?: string;
    metadata: { tags?: string[] };
  }>;

test('anonymous-write policy (tri-state)', async (t) => {
  await t.test('A. default global: anonymous write lands the global tier (behavior lock)', async (t) => {
    const ctx = install(t); // no scope option → DEFAULT_CONFIG: kind user, policy global
    await fire(ctx, 'message.user', anonEvent(ANON_CONTENT));

    const hits = semanticItems(ctx).filter((i) =>
      i.content.includes('QuarantineMarker'),
    );
    assert.ok(hits.length > 0, 'anonymous message produced semantic items');
    for (const h of hits) {
      assert.equal(h.visibility, 'global', 'legacy default: global bucket');
      // Falsy, not null: the row's session_id keeps its historical ''
      // (no synthetic '__anonymous__' owner is stamped under 'global').
      assert.ok(!h.sessionId, 'no synthetic owner stamped');
    }
  });

  await t.test('B. quarantine: isolation bucket, invisible to identified users', async (t) => {
    const ctx = install(t, { scope: { anonymousPolicy: 'quarantine' } });
    const palace = palaceOf(ctx);

    // B1 — anonymous message → session-tier '__anonymous__' bucket row.
    await fire(ctx, 'message.user', anonEvent(ANON_CONTENT));
    const quarantined = semanticItems(ctx).filter((i) =>
      i.content.includes('QuarantineMarker'),
    );
    assert.ok(quarantined.length > 0, 'anonymous message produced semantic items');
    for (const q of quarantined) {
      assert.equal(q.visibility, 'session', 'quarantine lands the session tier');
      assert.equal(q.sessionId, ANONYMOUS_SESSION_ID, 'owner is the synthetic bucket id');
    }

    // B2 — identified write is NOT rewritten by the policy: it keeps its
    // own narrowest owned tier (message carries sessionId + userId).
    await fire(ctx, 'message.user', {
      sessionId: 's-ident',
      payload: { content: ANON_CONTENT.replace('QuarantineMarker', 'IdentifiedMarker'), userId: 'u1' },
    });
    const identified = semanticItems(ctx).filter((i) =>
      i.content.includes('IdentifiedMarker'),
    );
    assert.ok(identified.length > 0, 'identified message produced semantic items');
    for (const it of identified) {
      assert.equal(it.visibility, 'session', 'identified write keeps its narrow tier');
      assert.equal(it.sessionId, 's-ident', 'identified write keeps its own session');
    }

    // B3 — an identified user retrieves ZERO of the quarantined content.
    const asUser = await palace.retriever.retrieve({
      query: ANON_QUERY,
      topK: 10,
      scope: { userId: 'u1' },
    });
    assert.ok(
      !asUser.hits.some((h: any) => h.item.content.includes('QuarantineMarker')),
      'identified user must not see the quarantine bucket',
    );

    // B4 — the anonymous-bucket caller reads its own writes back
    // (self-consistent isolation, not a black hole). Deliberately a
    // DIFFERENT query phrasing than B3: the semantic query cache keys by
    // query vector alone (scope-blind by design), so reusing B3's exact
    // text would serve its cached negative result.
    const asBucket = await palace.retriever.retrieve({
      query: 'QuarantineMarker Zephyr ledger reconciliation deltas OpsBridge',
      topK: 10,
      scope: { sessionId: ANONYMOUS_SESSION_ID },
    });
    assert.ok(
      asBucket.hits.some((h: any) => h.item.content.includes('QuarantineMarker')),
      'the __anonymous__ bucket caller retrieves its own writes',
    );
  });

  await t.test('C. reject: anonymous writes fail closed without crashing the handler', async (t) => {
    const ctx = install(t, { scope: { anonymousPolicy: 'reject' } });
    const palace = palaceOf(ctx);

    // C1 — the handler must RESOLVE (not throw) for an anonymous message.
    await fire(ctx, 'message.user', anonEvent(ANON_CONTENT));

    // C2 — nothing was written: zero semantic items, zero episodic events.
    const stats = palace.store.stats();
    assert.equal(stats.items.semantic, 0, 'no semantic rows from a rejected write');
    assert.equal(stats.events, 0, 'no episodic rows from a rejected write');

    // C3 — the rejection is observable in the logs (mock context records
    // every logger call).
    assert.ok(
      ctx.logs.some(
        (l) => l.level === 'warn' && /anonymousPolicy=reject/.test(l.msg),
      ),
      'a warn names the dropped anonymous message',
    );

    // C4 — identified traffic keeps flowing through the same handler.
    await fire(ctx, 'message.user', {
      sessionId: 's-ok',
      payload: { content: ANON_CONTENT.replace('QuarantineMarker', 'AcceptedMarker'), userId: 'u1' },
    });
    const accepted = semanticItems(ctx).filter((i) =>
      i.content.includes('AcceptedMarker'),
    );
    assert.ok(accepted.length > 0, 'identified message still ingested under reject');
  });

  await t.test('D. session.end: sleep stages honor the policy', async (t) => {
    await t.test('D1. quarantine — sleep writes land in the isolation bucket', async (t) => {
      const ctx = install(t, { scope: { anonymousPolicy: 'quarantine' } });

      // Raw material for the night shift: two anonymous messages whose
      // items live in the bucket (stratify folds THOSE into digests).
      await fire(ctx, 'message.user', anonEvent('DigiOne compiles the orbital telemetry index for the northern relay array every night without failures.'));
      await fire(ctx, 'message.user', anonEvent('DigiTwo archives the southern relay logs into cold storage before the morning standup begins.'));

      // Anonymous session.end: the scope handed to sleep is the bucket id.
      await fire(ctx, 'session.end', { sessionId: '', payload: {} });

      const digests = semanticItems(ctx).filter((i) =>
        (i.metadata.tags ?? []).includes('stratified'),
      );
      assert.ok(digests.length > 0, 'sleep built stratifier digest items');
      for (const d of digests) {
        assert.equal(
          d.sessionId,
          ANONYMOUS_SESSION_ID,
          'digest written into the __anonymous__ bucket',
        );
        assert.equal(d.visibility, 'session', 'digest row sits at the session tier');
      }
      // The dream itself ran to completion.
      assert.ok(
        ctx.emittedEvents.some((e) => e.name === 'memory.slept'),
        'memory.slept emitted for the quarantined sleep',
      );
    });

    await t.test('D2. reject — anonymous session.end is skipped, identified still sleeps', async (t) => {
      const ctx = install(t, { scope: { anonymousPolicy: 'reject' } });

      // Anonymous trigger: skipped with a warn, handler resolves.
      await fire(ctx, 'session.end', { sessionId: '', payload: {} });
      assert.ok(
        !ctx.emittedEvents.some((e) => e.name === 'memory.slept'),
        'no sleep ran for the anonymous session.end',
      );
      assert.ok(
        ctx.logs.some(
          (l) => l.level === 'warn' && /session\.end skipped/.test(l.msg),
        ),
        'the skip is logged as a warn',
      );

      // Identified trigger: sleep runs exactly as before.
      await fire(ctx, 'session.end', { sessionId: 's-night', payload: { userId: 'u1' } });
      assert.ok(
        ctx.emittedEvents.some((e) => e.name === 'memory.slept'),
        'identified session.end still sleeps under reject',
      );
    });
  });

  await t.test('E. install validation: non-tri-state policy fails loud', async (t) => {
    assert.throws(
      () => install(t, { scope: { anonymousPolicy: 'sometimes' } }),
      /anonymousPolicy.*global \| quarantine \| reject/,
      'invalid policy throws at install with the legal values listed',
    );
  });
});
