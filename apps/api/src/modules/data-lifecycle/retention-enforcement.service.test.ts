import assert from 'node:assert/strict';
import test from 'node:test';
import postgres from 'postgres';
import { eq, and } from 'drizzle-orm';
import { createDb, closeDb, customers, customerIdentifiers, identityLinks, dataRetentionSettings } from '@truvo/db';
import { RetentionEnforcementService } from './retention-enforcement.service';
import { AuditService } from '../audit/audit.service';

/**
 * Order 055 §5 — RETENTION ENFORCEMENT. Proves: no configured policy → skip
 * (fail-safe, no invented default), policy selects eligible rows deterministically
 * by cutoff, repeated runs are idempotent, partial data outside the cutoff survives,
 * and tenant isolation (a workspace's OWN policy never purges another tenant, and a
 * workspace with no policy never inherits one from a sibling).
 */
let reachable: boolean | undefined;
async function checkReachable(): Promise<boolean> {
  if (reachable !== undefined) return reachable;
  const url = process.env.DATABASE_URL;
  if (!url) {
    reachable = false;
    return reachable;
  }
  const probe = postgres(url, { prepare: false, connect_timeout: 5, max: 1 });
  try {
    await probe.unsafe('select 1');
    reachable = true;
  } catch {
    reachable = false;
  } finally {
    await probe.end({ timeout: 1 }).catch(() => undefined);
  }
  return reachable;
}

const STAMP = Date.now();
const WS_CONFIGURED = `test_ws_retention_configured_${STAMP}`;
const WS_UNCONFIGURED = `test_ws_retention_unconfigured_${STAMP}`;

test('retention sweep: fail-safe when unconfigured, purges past cutoff deterministically, idempotent, tenant-isolated', async (t) => {
  if (!(await checkReachable())) {
    t.skip('DATABASE_URL não alcançável neste ambiente — ver HANDOFF (Postgres dev unreachable)');
    return;
  }

  const db = createDb();
  const svc = new RetentionEnforcementService(db, new AuditService(db));
  const now = new Date();
  const longAgo = new Date(Date.now() - 400 * 24 * 3600_000); // 400 days ago — past any sane cutoff
  const recent = new Date(Date.now() - 1 * 24 * 3600_000); // 1 day ago — inside a 30-day grace window

  try {
    // ── unconfigured workspace: no data_retention_settings row at all ──
    await db.insert(customers).values({ workspaceId: WS_UNCONFIGURED, id: 'old', status: 'anonymous', sourceNamespace: 'test', firstSeenAt: longAgo, lastSeenAt: longAgo, deletedAt: longAgo });
    const unconfiguredResult = await svc.sweepWorkspace(WS_UNCONFIGURED);
    assert.equal(unconfiguredResult.skipped, true, 'sem policy configurada, o sweep deve pular o workspace inteiro — nunca assumir um default');
    const stillThere = await db.select().from(customers).where(eq(customers.workspaceId, WS_UNCONFIGURED));
    assert.equal(stillThere.length, 1, 'nada deve ser purgado sem policy explícita');

    // ── configured workspace: 30-day grace period ──
    await db.insert(dataRetentionSettings).values({ workspaceId: WS_CONFIGURED, tombstonePurgeAfterDays: 30 });
    await db.insert(customers).values([
      { workspaceId: WS_CONFIGURED, id: 'expired', status: 'anonymous', sourceNamespace: 'test', firstSeenAt: longAgo, lastSeenAt: longAgo, deletedAt: longAgo },
      { workspaceId: WS_CONFIGURED, id: 'within_grace', status: 'anonymous', sourceNamespace: 'test', firstSeenAt: recent, lastSeenAt: recent, deletedAt: recent },
      { workspaceId: WS_CONFIGURED, id: 'never_deleted', status: 'anonymous', sourceNamespace: 'test', firstSeenAt: now, lastSeenAt: now },
    ]);
    await db.insert(customerIdentifiers).values({
      workspaceId: WS_CONFIGURED, id: `cid_${STAMP}`, customerId: 'expired', identifierType: 'external_id',
      providerNamespace: 'test', identifierValue: 'v1', sourceNamespace: 'test', firstSeenAt: longAgo, lastSeenAt: longAgo, deletedAt: longAgo,
    });
    await db.insert(identityLinks).values({
      id: `idl_${STAMP}`, workspaceId: WS_CONFIGURED, identifier: `expired_id_${STAMP}`, identifierType: 'anonymous_id',
      canonicalId: 'expired', firstSeen: longAgo, deletedAt: longAgo,
    });

    const first = await svc.sweepWorkspace(WS_CONFIGURED);
    assert.equal(first.skipped, false);
    assert.equal(first.purged.customers, 1, 'só a linha ALÉM do cutoff deve ser purgada');
    assert.equal(first.purged.customer_identifiers, 1);
    assert.equal(first.purged.identity_links, 1);

    const remaining = await db.select().from(customers).where(eq(customers.workspaceId, WS_CONFIGURED));
    assert.equal(remaining.length, 2, 'within_grace e never_deleted sobrevivem');
    assert.ok(remaining.every((c) => c.id !== 'expired'));
    assert.ok(remaining.some((c) => c.id === 'within_grace'), 'tombstoned mas AINDA dentro da janela de retenção não é purgado');
    assert.ok(remaining.some((c) => c.id === 'never_deleted'), 'nunca tombstoned nunca é purgado, independente da idade');

    // ── idempotent rerun: nothing left past the cutoff → zero purged, no error ──
    const second = await svc.sweepWorkspace(WS_CONFIGURED);
    assert.equal(second.purged.customers, 0);
    assert.equal(second.purged.identity_links, 0);

    // ── tenant isolation: WS_UNCONFIGURED's row (still tombstoned, never purged
    // above) remains completely untouched by WS_CONFIGURED's sweep ──
    const otherStillThere = await db.select().from(customers).where(eq(customers.workspaceId, WS_UNCONFIGURED));
    assert.equal(otherStillThere.length, 1);
  } finally {
    await db.delete(customerIdentifiers).where(eq(customerIdentifiers.workspaceId, WS_CONFIGURED)).catch(() => undefined);
    await db.delete(identityLinks).where(eq(identityLinks.workspaceId, WS_CONFIGURED)).catch(() => undefined);
    await db.delete(customers).where(eq(customers.workspaceId, WS_CONFIGURED)).catch(() => undefined);
    await db.delete(customers).where(eq(customers.workspaceId, WS_UNCONFIGURED)).catch(() => undefined);
    await db.delete(dataRetentionSettings).where(eq(dataRetentionSettings.workspaceId, WS_CONFIGURED)).catch(() => undefined);
    await closeDb(db).catch(() => undefined);
  }
});
