// Live integration tests for the discovery decision write path
// against a real database. Skipped unless RUN_DB_TESTS=1. Expects:
//   DATABASE_URL                  the viewer role's URL (API reads)
//   DATABASE_URL_DISCOVERY_WRITE  the reviewer role's URL (API writes)
//   DISCOVERY_TEST_OWNER_URL      an owner/superuser URL (seeding and
//                                 assertions only; never given to the
//                                 API under test)
// server/scripts/test-discovery-roles.sh provisions a disposable
// database with exactly this shape. The suite seeds its own batch,
// candidates, and pair through the owner client and removes them
// afterwards; the API under test only ever connects as viewer +
// reviewer, so a green run also proves the reviewer role's grants are
// sufficient for the real decision flow (and that the viewer still
// cannot write: the flow's reads go through it).
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../src/app';
import { getPrisma } from '../src/db';
import { getDiscoveryWritePrisma } from '../src/discoveryWriteDb';

const run = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

run('discovery decisions against local database', () => {
  const owner = new PrismaClient({
    datasources: { db: { url: process.env.DISCOVERY_TEST_OWNER_URL as string } },
  });
  let adminId = 0;
  let batchId = 0;
  let soloId = 0;
  let flaggedId = 0;
  let rivalId = 0;
  let pairId = 0;
  let app: any;

  const auth = (req: request.Test) => req.set('Authorization', 'Bearer <redacted>');

  beforeAll(async () => {
    const admin = await owner.users.findUnique({ where: { uid: 'integration-admin' } });
    if (!admin) throw new Error('seed user integration-admin missing (see test-discovery-roles.sh)');
    adminId = admin.id;

    const batch = await owner.discovery_batches.create({
      data: {
        slug: `decisions-it-${Date.now()}`,
        title: 'Decision integration batch',
        source: 'integration',
        manifest: {},
        bundle_sha256: `it${Date.now()}`.padEnd(64, '0').slice(0, 64),
        candidates_sha256: 'a'.repeat(64),
        record_count: 3,
      },
    });
    batchId = batch.id;
    const mk = async (key: string, name: string) => owner.discovery_candidates.create({
      data: {
        batch_id: batchId,
        candidate_key: key,
        payload: {},
        name,
        brewery_name: 'Integration Brewing',
        source: 'integration',
        source_record_id: key,
        normalized_name: name.toLowerCase(),
        normalized_brewery: 'integration brewing',
      },
    });
    soloId = (await mk('it:solo', 'Solo Ale')).id;
    flaggedId = (await mk('it:flagged', 'Flagged Ale')).id;
    rivalId = (await mk('it:rival', 'Flagged Ale')).id;
    const pair = await owner.discovery_candidate_pairs.create({
      data: {
        batch_id: batchId,
        candidate_id: flaggedId,
        candidate_id_b: rivalId,
        comparison: 'name+brewery',
        method: 'exact',
        score: 100,
      },
    });
    pairId = pair.id;

    app = createApp({
      prisma: getPrisma(),
      writePrisma: null,
      discoveryWritePrisma: getDiscoveryWritePrisma(),
      presignGetUrl: null,
      verifyIdToken: async () => ({ uid: 'integration-admin', user_id: 'integration-admin', admin: true }),
      findUserByUid: async () => ({ id: adminId, uid: 'integration-admin', user_name: 'Integration Admin' }),
    });
  });

  afterAll(async () => {
    await owner.discovery_decisions.deleteMany({ where: { candidate_id: { in: [soloId, flaggedId, rivalId] } } });
    await owner.discovery_candidate_pairs.deleteMany({ where: { batch_id: batchId } });
    await owner.discovery_candidates.deleteMany({ where: { batch_id: batchId } });
    await owner.discovery_batches.deleteMany({ where: { id: batchId } });
    await owner.$disconnect();
  });

  it('selects a pending candidate and persists the audit row', async () => {
    const res = await auth(request(app).post(`/admin-api/v1/discovery/candidates/${soloId}/decide`))
      .send({ decision: 'select' });
    expect(res.status).toBe(200);
    expect(res.body.review_status).toBe('selected');
    const stored = await owner.discovery_candidates.findUnique({ where: { id: soloId } });
    expect(stored?.review_status).toBe('selected');
    const audit = await owner.discovery_decisions.findMany({ where: { candidate_id: soloId } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      decision: 'select', from_status: 'pending', to_status: 'selected', decided_by: adminId,
    });
    expect(audit[0].decided_by_uid).toBe('integration-admin');
    expect(JSON.stringify(res.body)).not.toContain('integration-admin');
  });

  it('refuses hold without a reason (422) and select on the held candidate after a hold (409)', async () => {
    const noReason = await auth(request(app).post(`/admin-api/v1/discovery/candidates/${soloId}/decide`))
      .send({ decision: 'hold' });
    expect(noReason.status).toBe(422);
    const held = await auth(request(app).post(`/admin-api/v1/discovery/candidates/${soloId}/decide`))
      .send({ decision: 'hold', reason: 'image_unverified' });
    expect(held.status).toBe(200);
    expect(held.body.review_status).toBe('held');
    const selectHeld = await auth(request(app).post(`/admin-api/v1/discovery/candidates/${soloId}/decide`))
      .send({ decision: 'select' });
    expect(selectHeld.status).toBe(409);
  });

  it('refuses select while the pair is unresolved, then same supersedes the flagged candidate', async () => {
    const blocked = await auth(request(app).post(`/admin-api/v1/discovery/candidates/${flaggedId}/decide`))
      .send({ decision: 'select' });
    expect(blocked.status).toBe(409);

    const res = await auth(request(app).post(`/admin-api/v1/discovery/pairs/${pairId}/decide`))
      .send({ decision: 'same' });
    expect(res.status).toBe(200);
    expect(res.body.candidate_review_status).toBe('superseded');
    const stored = await owner.discovery_candidates.findUnique({ where: { id: flaggedId } });
    expect(stored?.review_status).toBe('superseded');
    expect(stored?.duplicate_of_candidate_id).toBe(rivalId);
    const audit = await owner.discovery_decisions.findMany({ where: { pair_id: pairId } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ decision: 'mark_duplicate', candidate_id: flaggedId });

    const again = await auth(request(app).post(`/admin-api/v1/discovery/pairs/${pairId}/decide`))
      .send({ decision: 'distinct' });
    expect(again.status).toBe(409);
  });

  it('serves the audit trail with decider names and no UID', async () => {
    const res = await auth(request(app).get(`/admin-api/v1/discovery/batches/${batchId}/decisions`));
    expect(res.status).toBe(200);
    expect(res.body.pagination.total_results).toBe(3);
    for (const row of res.body.results) {
      expect(row.decided_by).toEqual({ id: adminId, user_name: 'Integration Admin' });
    }
    expect(JSON.stringify(res.body)).not.toContain('integration-admin');
    expect(JSON.stringify(res.body)).not.toContain('decided_by_uid');
  });
});
