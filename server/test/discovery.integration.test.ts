// Live integration tests for the discovery hub against a real
// database. Skipped unless RUN_DB_TESTS=1. Read only. Expects the
// discovery seed batches to have been ingested into the target
// database (see docs/DISCOVERY_HUB_RUNBOOK.md); the assertions are
// written against whatever batches are present rather than fixture
// ids, and reconcile the candidate list total against each batch's
// recorded record_count.
import request from 'supertest';
import { createApp } from '../src/app';
import { getPrisma } from '../src/db';

const run = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

run('discovery hub against local database', () => {
  const prisma = getPrisma();
  const app = createApp({
    resolveAdminAccess: async () => 'owner',
    prisma,
    verifyIdToken: async () => ({ uid: 'integration-admin', user_id: 'integration-admin', admin: true }),
    findUserByUid: async () => ({ id: 1, uid: 'integration-admin' }),
  });
  const auth = (req: request.Test) => req.set('Authorization', 'Bearer <redacted>');

  it('lists batches with counts that reconcile to record_count', async () => {
    const res = await auth(request(app).get('/admin-api/v1/discovery/batches'));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.results)).toBe(true);
    expect(res.body.results.length).toBeGreaterThanOrEqual(1);
    for (const batch of res.body.results) {
      const byReview = Object.values(batch.counts.by_review_status as Record<string, number>)
        .reduce((a: number, b: number) => a + b, 0);
      expect(byReview).toBe(batch.record_count);
      expect(batch.review_progress.total).toBe(batch.record_count);
    }
  });

  it('candidate list total matches the batch record_count and detail loads', async () => {
    const batches = await auth(request(app).get('/admin-api/v1/discovery/batches'));
    const batch = batches.body.results[0];
    const list = await auth(request(app).get(`/admin-api/v1/discovery/batches/${batch.id}/candidates?page_size=5`));
    expect(list.status).toBe(200);
    expect(list.body.pagination.total_results).toBe(batch.record_count);
    const first = list.body.results[0];
    const detail = await auth(request(app).get(`/admin-api/v1/discovery/candidates/${first.id}`));
    expect(detail.status).toBe(200);
    expect(detail.body.candidate_key).toBe(first.candidate_key);
    expect(Array.isArray(detail.body.pairs)).toBe(true);
  });

  it('hold_reason=none filter returns only unheld candidates', async () => {
    const batches = await auth(request(app).get('/admin-api/v1/discovery/batches'));
    const batch = batches.body.results[0];
    const res = await auth(request(app).get(
      `/admin-api/v1/discovery/batches/${batch.id}/candidates?hold_reason=none&page_size=100`));
    expect(res.status).toBe(200);
    for (const row of res.body.results) {
      expect(row.hold_reason).toBeNull();
    }
    const expected = batch.counts.by_hold_reason.none || 0;
    expect(res.body.pagination.total_results).toBe(expected);
  });
});
