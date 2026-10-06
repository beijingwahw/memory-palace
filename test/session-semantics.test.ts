/**
 * SESSION-GROUP SEMANTICS — pinned at the REAL plugin boundary.
 *
 * 本文件钉死 D-09 验证属性：session 是共享可见组，冒充 sessionId 获得组内
 * 可见性是设计内威胁模型（bearer credential），不是 bug。
 *
 * What that means operationally (DECISIONS D-09, INVARIANTS I-ACL-17):
 * the session tier's visibility condition is EXACTLY `session_id = ?` —
 * no userId check, no workspaceId check. A caller who presents the same
 * sessionId therefore sees the group's rows BY DESIGN, even if every
 * other identity field differs. Anyone "fixing" that would break the
 * collaborative-session semantics the tier exists for; this file exists
 * so such a "fix" fails HERE, loudly, next to the threat-model note.
 *
 *   A  impersonation grants visibility (THE pin) — a different user who
 *      DELIBERATELY carries the victim's sessionId retrieves the
 *      victim's session-tier rows. Asserted as a HIT.
 *   B  out-of-group exclusion — same attacker, own sessionId → ZERO
 *      hits on the victim's rows (the bearer credential is the ONLY
 *      key; not holding it means not seeing the group).
 *   C  in-group boundaries —
 *      C1: same sessionId but a DIFFERENT workspace (and user) still
 *          sees the rows: the group's sole key is sessionId, workspace
 *          equality is NOT part of the contract;
 *      C2: a USER-tier row is invisible to a same-session caller with
 *          no userId — session membership does not widen tiers (the
 *          group is a visibility group, not an escalation ladder).
 *   D  weak-session-id hygiene warn — the ONE mitigation the design
 *      does ship (D-09's residual risk, made observable): guessable
 *      session ids warn exactly once per id at the message handlers,
 *      with zero behavior change otherwise.
 *
 * Determinism: no randomness feeds any assertion — fixed marker-bearing
 * contents, offline (hash-based) embeddings, one throwaway database per
 * subtest, handlers driven DIRECTLY (awaited, never raced through
 * ctx.emit), and distinct query phrasings per retrieval within a
 * subtest (the semantic query cache is scope-blind BY DESIGN — reusing
 * one query's exact text across different scopes would serve its
 * cached result; the anonymous-policy suite established the same
 * discipline). Windows WAL close-before-rm hook order copied from
 * integration.test.ts / anonymous-policy.test.ts: the store-close hook
 * registers BEFORE freshDb registers the tmpdir removal.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import MemoryPalacePlugin from '../src/index.ts';
import { createMockContext, type MockContext } from './mock-context.ts';
import type { CordisEvent, ToolContext } from '../src/types/cordis.ts';

/** Marker-bearing victim payload: long enough to clear the chunker's
 *  16-token semantic-candidate gate, distinctive enough that offline-bm25
 *  retrieval locks onto it. One marker word per subtest keeps store-level
 *  ground-truth checks unambiguous. */
const A_CONTENT =
  'GroupMarker Kestrel maintains the vault seal audit trail for the ' +
  'northern observatory and files the nightly differential report with ' +
  'the guild registry before the second bell of every watch shift ends.';

const A_QUERY = 'GroupMarker Kestrel vault seal audit trail';

const B_QUERY = 'Kestrel observatory nightly differential guild report';

const C1_QUERY = 'GroupMarker Kestrel vault seal northern observatory trail';

const C2_NEG_QUERY = 'FalconVeil launch window trajectory burn';

const C2_POS_QUERY = 'FalconVeil launch window burn schedule';

/** Minimal structural handle for registering cleanup on a (sub)test. */
interface AfterHooks {
  after: (fn: () => void) => void;
}

/** A brand-new temporary database path, cleaned up after the subtest. */
const freshDb = (t: AfterHooks): string => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sess-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'memory.db');
};

/**
 * Install the plugin against a fresh, subtest-private database (default
 * config: scope kind 'user', anonymousPolicy 'global' — the zero-config
 * world every host actually runs). Hook ORDER is the whole game on
 * Windows: the store close must be registered BEFORE freshDb's tmpdir rm
 * (hooks run in registration order), or rmSync hits the open WAL handle.
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

const palaceOf = (ctx: MockContext) => ctx.services.get('memory-palace') as any;

const semanticItems = (ctx: MockContext) =>
  palaceOf(ctx).store.listItemsByLayer('semantic', 500) as Array<{
    content: string;
    visibility?: string;
    sessionId?: string;
    userId?: string;
  }>;

/** The victim's write, as a real host would deliver it: identified user
 *  inside session 'sess-shared'. Messages land the session tier owned by
 *  exactly that sessionId (pinned by anonymous-policy B2). */
const victimMessage = (content: string): CordisEvent => ({
  sessionId: 'sess-shared',
  payload: { content, userId: 'u-victim' },
});

/** Count the hygiene warns emitted for one session id. */
const warnCount = (ctx: MockContext, sessionId: string): number =>
  ctx.logs.filter(
    (l) =>
      l.level === 'warn' &&
      l.msg.includes(`session id "${sessionId}" is guessable`),
  ).length;

test('session-group semantics (D-09 pinned)', async (t) => {
  await t.test('A. impersonation grants visibility — pinned as DESIGN, not a bug', async (t) => {
    const ctx = install(t);
    const palace = palaceOf(ctx);

    // Ground truth first: the victim's message produced session-tier rows
    // owned by 'sess-shared' (if this ever fails, the subtest is no longer
    // testing what it claims to test).
    await fire(ctx, 'message.user', victimMessage(A_CONTENT));
    const rows = semanticItems(ctx).filter((i) => i.content.includes('GroupMarker'));
    assert.ok(rows.length > 0, 'victim message produced semantic items');
    for (const r of rows) {
      assert.equal(r.visibility, 'session', 'victim write sits at the session tier');
      assert.equal(r.sessionId, 'sess-shared', 'victim write is owned by sess-shared');
    }

    // THE PIN (INVARIANTS I-ACL-17 / DECISIONS D-09): u-attacker carries
    // sess-shared DELIBERATELY — no other identity is shared — and
    // retrieves the victim's rows. This MUST hit: the session tier is a
    // bearer-credential visibility group; presenting the id IS the
    // authorization. "Fixing" this behavior (e.g. adding a userId check
    // to session rows) would break every collaborative-session and
    // agent-relay consumer of the tier — it is the designed threat
    // model, not an ACL defect. The correct mitigation for guessable
    // ids is the D-09 hygiene warn (subtest D), not a semantic change.
    const asAttacker = await palace.retriever.retrieve({
      query: A_QUERY,
      topK: 10,
      scope: { userId: 'u-attacker', sessionId: 'sess-shared' },
    });
    assert.ok(
      asAttacker.hits.some((h: any) => h.item.content.includes('GroupMarker')),
      'DELIBERATE PIN: caller presenting the victim sessionId sees the session group (bearer credential, D-09 / I-ACL-17)',
    );
  });

  await t.test('B. different session: zero visibility into the group', async (t) => {
    const ctx = install(t);
    const palace = palaceOf(ctx);

    await fire(ctx, 'message.user', victimMessage(A_CONTENT));
    assert.ok(
      semanticItems(ctx).some((i) => i.content.includes('GroupMarker')),
      'victim write landed (precondition)',
    );

    // Same attacker identity, but their OWN session id — the bearer
    // credential is absent, so the widening cascade (which NEVER crosses
    // an owner boundary, I-ACL-05) must not reach the victim's rows.
    // Distinct query phrasing from subtest A's: fresh install means a
    // fresh cache, but the discipline is kept anyway.
    const asAttacker = await palace.retriever.retrieve({
      query: B_QUERY,
      topK: 10,
      scope: { userId: 'u-attacker', sessionId: 'sess-attacker' },
    });
    assert.ok(
      !asAttacker.hits.some((h: any) => h.item.content.includes('GroupMarker')),
      'attacker without the sessionId sees ZERO of the group (mutual exclusion across groups)',
    );
  });

  await t.test('C. in-group boundaries', async (t) => {
    await t.test('C1. group key is sessionId ONLY — cross-workspace caller still sees', async (t) => {
      const ctx = install(t);
      const palace = palaceOf(ctx);

      await fire(ctx, 'message.user', victimMessage(A_CONTENT));
      assert.ok(
        semanticItems(ctx).some((i) => i.content.includes('GroupMarker')),
        'victim write landed (precondition)',
      );

      // A caller whose workspace AND user differ from the victim's, but
      // who presents sess-shared: still in the group. The session
      // group's sole key is sessionId — scope.ts's session-tier
      // condition is exactly `(visibility = 'session' AND session_id =
      // ?)` with no workspace/user conjunct. Requiring workspace
      // equality would silently splinter every multi-workspace
      // collaborative session.
      const asCrosser = await palace.retriever.retrieve({
        query: C1_QUERY,
        topK: 10,
        scope: {
          userId: 'u-crosser',
          workspaceId: 'ws-other',
          sessionId: 'sess-shared',
        },
      });
      assert.ok(
        asCrosser.hits.some((h: any) => h.item.content.includes('GroupMarker')),
        'same sessionId + foreign workspace/user still sees the group (group key = sessionId only)',
      );
    });

    await t.test('C2. group membership does not widen tiers — user-tier row hidden from userId-less peer', async (t) => {
      const ctx = install(t);
      const palace = palaceOf(ctx);

      // A USER-tier row owned by u-victim. Written via memory_remember
      // with an EMPTY sessionId in the tool context (the ToolContract
      // requires the field; '' carries no group membership anywhere —
      // every tier check treats a falsy sessionId as absent): write
      // tiers resolve privacy-first, so an explicit visibility:'user'
      // from inside a real session would collapse to the (narrower)
      // session tier. The pinned property below is about the PEER's
      // read side and is independent of which context minted the row.
      const remember = ctx.tools.find((tool: any) => tool.name === 'memory_remember');
      assert.ok(remember, 'memory_remember tool registered');
      const victimTctx: ToolContext = { sessionId: '', userId: 'u-victim' };
      await remember.run(
        {
          content:
            'FalconVeil launch window is the second dawn burn with a ' +
            'gravity assist past the relay beacons before the final ' +
            'approach corridor opens for the escort formation.',
          importance: 0.9,
          visibility: 'user',
        },
        victimTctx,
      );

      // Ground truth: the row exists, at the user tier, owned by u-victim.
      const rows = semanticItems(ctx).filter((i) => i.content.includes('FalconVeil'));
      assert.ok(rows.length > 0, 'user-tier write produced semantic items');
      for (const r of rows) {
        assert.equal(r.visibility, 'user', 'explicit visibility=user honored');
        assert.equal(r.userId, 'u-victim', 'user-tier row owned by the writer');
      }

      // Same-session peer WITHOUT a userId: the session group grants the
      // session tier (and global), never the user tier — visibility
      // there requires exact userId equality, which no group membership
      // can substitute for. Negative first (distinct phrasing), then the
      // positive control so the negative cannot be vacuous.
      const asPeer = await palace.retriever.retrieve({
        query: C2_NEG_QUERY,
        topK: 10,
        scope: { sessionId: 'sess-shared' },
      });
      assert.ok(
        !asPeer.hits.some((h: any) => h.item.content.includes('FalconVeil')),
        'userId-less same-session peer cannot see the user-tier row (group does not widen tiers)',
      );

      const asOwner = await palace.retriever.retrieve({
        query: C2_POS_QUERY,
        topK: 10,
        scope: { userId: 'u-victim' },
      });
      assert.ok(
        asOwner.hits.some((h: any) => h.item.content.includes('FalconVeil')),
        'positive control: the owner still retrieves the row',
      );
    });
  });

  await t.test('D. weak session ids warn exactly once, behavior unchanged', async (t) => {
    const ctx = install(t);

    // Contents are marker-bearing AND ~35 words: the chunker's semantic
    // candidate gate drops anything under 16 tokens, so thin one-liners
    // would never reach the semantic layer being asserted on below.
    // 'default' — weak (wordlist; also under the length floor).
    await fire(ctx, 'message.user', {
      sessionId: 'default',
      payload: {
        content:
          'HygieneOne catalogs the lantern inventory for the eastern annex ' +
          'during every thaw season and cross-checks each entry against the ' +
          'warden ledger before the morning rotation takes over the floor.',
      },
    });
    assert.equal(warnCount(ctx, 'default'), 1, 'one warn for the first weak id use');

    // Second 'default' message (assistant handler this time — both
    // entry points warn): per-id-once means NO second warn.
    await fire(ctx, 'message.assistant', {
      sessionId: 'default',
      payload: {
        content:
          'HygieneTwo reconciles the annex ledger against the lantern ' +
          'inventory the same night and posts the residual deltas to the ' +
          'quartermaster queue for the evening watch to review.',
      },
    });
    assert.equal(warnCount(ctx, 'default'), 1, 'repeat use of the same weak id does not re-warn');

    // Strong id (13 chars, mixed alnum, not in the wordlist): silent.
    await fire(ctx, 'message.user', {
      sessionId: 'a1b2c3d9strong',
      payload: {
        content:
          'HygieneThree seals the annex ledger, archives it with the thaw ' +
          'registry, and notifies the archival board once the wax stamp ' +
          'dries on the outer binding of the season folio.',
      },
    });
    assert.equal(
      ctx.logs.filter((l) => l.level === 'warn' && l.msg.includes('is guessable')).length,
      1,
      'strong session id produces no hygiene warn',
    );

    // Pure-numeric 8-char id: passes the length floor but is still
    // enumerable — exactly one warn.
    await fire(ctx, 'message.user', {
      sessionId: '12345678',
      payload: {
        content:
          'HygieneFour posts the thaw registry deltas to the annex notice ' +
          'board and pins the summary sheet beside the warden station ' +
          'mailbox for the arriving shift to acknowledge in writing.',
      },
    });
    assert.equal(warnCount(ctx, '12345678'), 1, 'numeric id warns despite passing the length floor');

    // And a final 'default' message still does not re-warn.
    await fire(ctx, 'message.user', {
      sessionId: 'default',
      payload: {
        content:
          'HygieneFive locks the annex, returns the lantern key to the ' +
          'warden cabinet, and records the closing hour in the patrol ' +
          'journal so the next opening rotation can verify the seal.',
      },
    });
    assert.equal(warnCount(ctx, 'default'), 1, 'third default use stays at one warn');

    // Zero behavior change: every message ingested normally despite the
    // weak ids (the warn is advisory only).
    const items = semanticItems(ctx);
    for (const marker of ['HygieneOne', 'HygieneTwo', 'HygieneThree', 'HygieneFour', 'HygieneFive']) {
      assert.ok(
        items.some((i) => i.content.includes(marker)),
        `${marker} ingested despite weak session id (warn-only, no behavior change)`,
      );
    }
  });
});
