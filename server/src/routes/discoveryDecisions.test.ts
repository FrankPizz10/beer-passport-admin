// Discovery decision write path (POST /admin-api/v1/discovery/
// candidates/:id/decide and /pairs/:id/decide) plus the audit reads:
// - auth is the shared middleware: 401 without a token.
// - 503 when the discovery write path is not configured
//   (DATABASE_URL_DISCOVERY_WRITE unset, modeled by a null client).
// - candidate vocabulary select/hold/reject/unhold (issues/001); hold
//   and reject require a vocabulary reason (422 missing, 400 unknown,
//   422 for 'other' without a note); a held candidate cannot be
//   selected; a select is refused while an unresolved pair exists;
//   rejected/superseded are final (409).
// - pair vocabulary same/distinct; 'same' supersedes the flagged
//   candidate and sets its duplicate pointer in the same transaction;
//   an already-decided pair is a 409.
// - every successful decision updates with a status predicate and
//   inserts the discovery_decisions audit row in ONE transaction on
//   the write client; a zero-row update aborts with 409 and writes no
//   audit row.
// - the Firebase UID is recorded on the audit row but never appears
//   in any response payload.
// All Prisma dependencies are stubs; no database.
import request from 'supertest';
import { createApp } from '../app';

const ADMIN_UID = 'admin-uid-secret';

const adminDeps = {
  verifyIdToken: jest.fn(async () => ({ uid: ADMIN_UID, user_id: ADMIN_UID, admin: true })),
  findUserByUid: jest.fn(async () => ({ id: 1, uid: ADMIN_UID, user_name: 'Admin One' })),
};

const candidateRow = (overrides: Record<string, unknown> = {}) => ({
  id: 11,
  batch_id: 3,
  candidate_key: 'wikidata:Q123',
  name: 'Candidate Ale',
  brewery_name: 'Candidate Brewing',
  style: 'IPA',
  abv: 6.5,
  barcode: '123456789012',
  source: 'wikidata',
  origin_bucket: 'us_produced',
  image_status: 'verified',
  image_status_normalized: 'verified',
  image_verified: true,
  hold_reason: null,
  review_status: 'pending',
  dedupe_outcome: 'no_match',
  matched_beer_id: null,
  ...overrides,
});

const pairRow = (overrides: Record<string, unknown> = {}) => ({
  id: 21,
  batch_id: 3,
  candidate_id: 11,
  candidate_id_b: 12,
  external_ref: null,
  comparison: 'name+brewery',
  method: 'fuzzy',
  score: 88.5,
  status: 'pending',
  decided_by: null,
  decided_at: null,
  created_at: new Date('2026-11-23T00:00:00Z'),
  ...overrides,
});

const readPrismaWith = ({
  candidate = candidateRow(),
  pair = pairRow(),
  pendingPairCount = 0,
  decisions = [] as any[],
}: {
  candidate?: any;
  pair?: any;
  pendingPairCount?: number;
  decisions?: any[];
} = {}) => ({
  discovery_candidates: {
    findUnique: jest.fn(async ({ where }: any) =>
      candidate && where.id === candidate.id ? candidate : null),
  },
  discovery_candidate_pairs: {
    findUnique: jest.fn(async ({ where }: any) =>
      pair && where.id === pair.id ? pair : null),
    count: jest.fn(async () => pendingPairCount),
  },
  discovery_batches: {
    findUnique: jest.fn(async ({ where }: any) => (where.id === 3 ? { id: 3 } : null)),
  },
  discovery_decisions: {
    count: jest.fn(async () => decisions.length),
    findMany: jest.fn(async () => decisions),
  },
});

const makeWritePrisma = (updateCount = 1, pairUpdateCount = 1) => {
  const tx = {
    discovery_candidates: { updateMany: jest.fn(async () => ({ count: updateCount })) },
    discovery_candidate_pairs: { updateMany: jest.fn(async () => ({ count: pairUpdateCount })) },
    discovery_decisions: { create: jest.fn(async () => ({ id: 99 })) },
  };
  const writePrisma = { $transaction: jest.fn(async (fn: any) => fn(tx)) };
  return { writePrisma, tx };
};

const auth = (req: request.Test) => req.set('Authorization', 'Bearer <redacted>');

const appWith = (read: any, writePrisma: any) =>
  createApp({
    prisma: read,
    writePrisma: null,
    discoveryWritePrisma: writePrisma,
    presignGetUrl: null,
    ...adminDeps,
  } as any);

describe('POST /discovery/candidates/:id/decide', () => {
  it('selects a pending candidate and writes the audit row in one transaction', async () => {
    const { writePrisma, tx } = makeWritePrisma();
    const app = appWith(readPrismaWith(), writePrisma);
    const res = await auth(request(app).post('/admin-api/v1/discovery/candidates/11/decide'))
      .send({ decision: 'select' });
    expect(res.status).toBe(200);
    expect(res.body.review_status).toBe('selected');
    expect(tx.discovery_candidates.updateMany).toHaveBeenCalledWith({
      where: { id: 11, review_status: 'pending' },
      data: expect.objectContaining({ review_status: 'selected', hold_reason: null }),
    });
    expect(tx.discovery_decisions.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        candidate_id: 11, pair_id: null, decision: 'select',
        from_status: 'pending', to_status: 'selected',
        decided_by: 1, decided_by_uid: ADMIN_UID,
      }),
    });
    expect(JSON.stringify(res.body)).not.toContain(ADMIN_UID);
  });

  it('refuses select while an unresolved duplicate pair exists (409, no write)', async () => {
    const { writePrisma, tx } = makeWritePrisma();
    const app = appWith(readPrismaWith({ pendingPairCount: 1 }), writePrisma);
    const res = await auth(request(app).post('/admin-api/v1/discovery/candidates/11/decide'))
      .send({ decision: 'select' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/unresolved duplicate pair/);
    expect(writePrisma.$transaction).not.toHaveBeenCalled();
    expect(tx.discovery_decisions.create).not.toHaveBeenCalled();
  });

  it('refuses select on a held candidate (409)', async () => {
    const { writePrisma } = makeWritePrisma();
    const app = appWith(
      readPrismaWith({ candidate: candidateRow({ review_status: 'held', hold_reason: 'origin_uncertain' }) }),
      writePrisma,
    );
    const res = await auth(request(app).post('/admin-api/v1/discovery/candidates/11/decide'))
      .send({ decision: 'select' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/held candidate cannot be selected/);
  });

  it('holds a selected candidate with a vocabulary reason', async () => {
    const { writePrisma, tx } = makeWritePrisma();
    const app = appWith(
      readPrismaWith({ candidate: candidateRow({ review_status: 'selected' }) }), writePrisma);
    const res = await auth(request(app).post('/admin-api/v1/discovery/candidates/11/decide'))
      .send({ decision: 'hold', reason: 'image_unverified', note: 'Image is a label mockup.' });
    expect(res.status).toBe(200);
    expect(res.body.review_status).toBe('held');
    expect(res.body.hold_reason).toBe('image_unverified');
    expect(tx.discovery_decisions.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        decision: 'hold', from_status: 'selected', to_status: 'held',
        reason: 'image_unverified', note: 'Image is a label mockup.',
      }),
    });
  });

  it('refuses hold without a reason (422), with an unknown reason (400), and other without a note (422)', async () => {
    const { writePrisma } = makeWritePrisma();
    const app = appWith(readPrismaWith(), writePrisma);
    const missing = await auth(request(app).post('/admin-api/v1/discovery/candidates/11/decide'))
      .send({ decision: 'hold' });
    expect(missing.status).toBe(422);
    const unknown = await auth(request(app).post('/admin-api/v1/discovery/candidates/11/decide'))
      .send({ decision: 'reject', reason: 'not_a_reason' });
    expect(unknown.status).toBe(400);
    const otherNoNote = await auth(request(app).post('/admin-api/v1/discovery/candidates/11/decide'))
      .send({ decision: 'hold', reason: 'other' });
    expect(otherNoNote.status).toBe(422);
    expect(writePrisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a pending candidate with a reason', async () => {
    const { writePrisma, tx } = makeWritePrisma();
    const app = appWith(readPrismaWith(), writePrisma);
    const res = await auth(request(app).post('/admin-api/v1/discovery/candidates/11/decide'))
      .send({ decision: 'reject', reason: 'out_of_scope' });
    expect(res.status).toBe(200);
    expect(res.body.review_status).toBe('rejected');
    expect(tx.discovery_decisions.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ decision: 'reject', to_status: 'rejected', reason: 'out_of_scope' }),
    });
  });

  it('unholds a held candidate back to pending and clears the reason', async () => {
    const { writePrisma, tx } = makeWritePrisma();
    const app = appWith(
      readPrismaWith({ candidate: candidateRow({ review_status: 'held', hold_reason: 'missing_brewery' }) }),
      writePrisma,
    );
    const res = await auth(request(app).post('/admin-api/v1/discovery/candidates/11/decide'))
      .send({ decision: 'unhold' });
    expect(res.status).toBe(200);
    expect(res.body.review_status).toBe('pending');
    expect(res.body.hold_reason).toBeNull();
    expect(tx.discovery_candidates.updateMany).toHaveBeenCalledWith({
      where: { id: 11, review_status: 'held' },
      data: expect.objectContaining({ review_status: 'pending', hold_reason: null }),
    });
  });

  it('refuses any decision on a final candidate (409) and unknown candidates (404)', async () => {
    const { writePrisma } = makeWritePrisma();
    const finalApp = appWith(
      readPrismaWith({ candidate: candidateRow({ review_status: 'rejected' }) }), writePrisma);
    const finalRes = await auth(request(finalApp).post('/admin-api/v1/discovery/candidates/11/decide'))
      .send({ decision: 'unhold' });
    expect(finalRes.status).toBe(409);

    const missingApp = appWith(readPrismaWith({ candidate: null }), writePrisma);
    const missingRes = await auth(request(missingApp).post('/admin-api/v1/discovery/candidates/11/decide'))
      .send({ decision: 'select' });
    expect(missingRes.status).toBe(404);
  });

  it('refuses an unknown decision string (400)', async () => {
    const { writePrisma } = makeWritePrisma();
    const app = appWith(readPrismaWith(), writePrisma);
    const res = await auth(request(app).post('/admin-api/v1/discovery/candidates/11/decide'))
      .send({ decision: 'accept' });
    expect(res.status).toBe(400);
    expect(writePrisma.$transaction).not.toHaveBeenCalled();
  });

  it('aborts with 409 and no audit row when a concurrent decision wins the predicate', async () => {
    const { writePrisma, tx } = makeWritePrisma(0);
    const app = appWith(readPrismaWith(), writePrisma);
    const res = await auth(request(app).post('/admin-api/v1/discovery/candidates/11/decide'))
      .send({ decision: 'select' });
    expect(res.status).toBe(409);
    expect(tx.discovery_decisions.create).not.toHaveBeenCalled();
  });

  it('answers 503 when the discovery write path is not configured', async () => {
    const app = appWith(readPrismaWith(), null);
    const res = await auth(request(app).post('/admin-api/v1/discovery/candidates/11/decide'))
      .send({ decision: 'select' });
    expect(res.status).toBe(503);
    expect(res.body.error.message).toMatch(/DATABASE_URL_DISCOVERY_WRITE/);
  });

  it('requires auth (401 without a token)', async () => {
    const { writePrisma } = makeWritePrisma();
    const app = appWith(readPrismaWith(), writePrisma);
    const res = await request(app).post('/admin-api/v1/discovery/candidates/11/decide')
      .send({ decision: 'select' });
    expect(res.status).toBe(401);
  });
});

describe('POST /discovery/pairs/:id/decide', () => {
  it('same: decides the pair, supersedes the candidate, sets the duplicate pointer, audits mark_duplicate', async () => {
    const { writePrisma, tx } = makeWritePrisma();
    const app = appWith(readPrismaWith(), writePrisma);
    const res = await auth(request(app).post('/admin-api/v1/discovery/pairs/21/decide'))
      .send({ decision: 'same' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('same');
    expect(res.body.candidate_review_status).toBe('superseded');
    expect(res.body.decided_by).toEqual({ id: 1, user_name: 'Admin One' });
    expect(tx.discovery_candidate_pairs.updateMany).toHaveBeenCalledWith({
      where: { id: 21, status: 'pending' },
      data: expect.objectContaining({ status: 'same', decided_by: 1 }),
    });
    expect(tx.discovery_candidates.updateMany).toHaveBeenCalledWith({
      where: { id: 11, review_status: 'pending' },
      data: expect.objectContaining({
        review_status: 'superseded', duplicate_of_candidate_id: 12,
      }),
    });
    expect(tx.discovery_decisions.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        candidate_id: 11, pair_id: 21, decision: 'mark_duplicate',
        from_status: 'pending', to_status: 'same', decided_by_uid: ADMIN_UID,
      }),
    });
    expect(JSON.stringify(res.body)).not.toContain(ADMIN_UID);
  });

  it('distinct: decides the pair and leaves the candidate untouched, audits mark_distinct', async () => {
    const { writePrisma, tx } = makeWritePrisma();
    const app = appWith(readPrismaWith(), writePrisma);
    const res = await auth(request(app).post('/admin-api/v1/discovery/pairs/21/decide'))
      .send({ decision: 'distinct', note: 'Different breweries.' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('distinct');
    expect(res.body.candidate_review_status).toBe('pending');
    expect(tx.discovery_candidates.updateMany).not.toHaveBeenCalled();
    expect(tx.discovery_decisions.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ decision: 'mark_distinct', note: 'Different breweries.' }),
    });
  });

  it('refuses an already-decided pair (409), an unknown pair (404), and a bad decision (400)', async () => {
    const { writePrisma } = makeWritePrisma();
    const decidedApp = appWith(
      readPrismaWith({ pair: pairRow({ status: 'same' }) }), writePrisma);
    expect((await auth(request(decidedApp).post('/admin-api/v1/discovery/pairs/21/decide'))
      .send({ decision: 'distinct' })).status).toBe(409);

    const missingApp = appWith(readPrismaWith({ pair: null }), writePrisma);
    expect((await auth(request(missingApp).post('/admin-api/v1/discovery/pairs/21/decide'))
      .send({ decision: 'same' })).status).toBe(404);

    const badApp = appWith(readPrismaWith(), writePrisma);
    expect((await auth(request(badApp).post('/admin-api/v1/discovery/pairs/21/decide'))
      .send({ decision: 'duplicate' })).status).toBe(400);
  });

  it('answers 503 when the discovery write path is not configured', async () => {
    const app = appWith(readPrismaWith(), null);
    const res = await auth(request(app).post('/admin-api/v1/discovery/pairs/21/decide'))
      .send({ decision: 'same' });
    expect(res.status).toBe(503);
  });
});

describe('decision audit reads', () => {
  const decisionRows = [{
    id: 5, candidate_id: 11, pair_id: null, decision: 'hold',
    from_status: 'pending', to_status: 'held', reason: 'origin_uncertain',
    note: null, decided_by: 1, decided_by_uid: ADMIN_UID,
    created_at: new Date('2026-11-23T12:00:00Z'),
    decider: { id: 1, user_name: 'Admin One' },
  }];

  it('lists a candidate\'s decisions newest first with the decider named, never the UID', async () => {
    const { writePrisma } = makeWritePrisma();
    const app = appWith(readPrismaWith({ decisions: decisionRows }), writePrisma);
    const res = await auth(request(app).get('/admin-api/v1/discovery/candidates/11/decisions'));
    expect(res.status).toBe(200);
    expect(res.body.pagination.total_results).toBe(1);
    expect(res.body.results[0]).toMatchObject({
      decision: 'hold', reason: 'origin_uncertain',
      decided_by: { id: 1, user_name: 'Admin One' },
    });
    expect(JSON.stringify(res.body)).not.toContain(ADMIN_UID);
    expect(JSON.stringify(res.body)).not.toContain('decided_by_uid');
  });

  it('lists a batch\'s decisions and 404s an unknown batch', async () => {
    const { writePrisma } = makeWritePrisma();
    const app = appWith(readPrismaWith({ decisions: decisionRows }), writePrisma);
    const res = await auth(request(app).get('/admin-api/v1/discovery/batches/3/decisions'));
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    const missing = await auth(request(app).get('/admin-api/v1/discovery/batches/999/decisions'));
    expect(missing.status).toBe(404);
    const missingCandidate = await auth(request(app).get('/admin-api/v1/discovery/candidates/999/decisions'));
    expect(missingCandidate.status).toBe(404);
  });
});
