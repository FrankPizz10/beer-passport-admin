// Discovery hub read routes: batch rollups, the candidate list
// envelope and filter validation, and candidate detail with pairs.
// All Prisma dependencies are stubs; no database.
import request from 'supertest';
import { createApp } from '../app';

const adminDeps = {
  verifyIdToken: jest.fn(async () => ({ uid: 'admin-uid', user_id: 'admin-uid', admin: true })),
  findUserByUid: jest.fn(async () => ({ id: 1, uid: 'admin-uid' })),
};

const batchRow = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  slug: 'reassessment-us',
  title: 'Reassessment: US priority',
  source: 'reassessment',
  source_summary: 'US-produced and US-market candidates',
  manifest: {},
  bundle_sha256: 'a'.repeat(64),
  candidates_sha256: 'a'.repeat(64),
  record_count: 4,
  status: 'staged',
  ingested_by: 'operator',
  ingested_at: new Date('2026-11-23T00:00:00Z'),
  ...overrides,
});

const candidateRow = (overrides: Record<string, unknown> = {}) => ({
  id: 11,
  batch_id: 1,
  candidate_key: 'wikidata:Q123',
  payload: {},
  name: 'Hazy Wonder',
  brewery_name: 'Example Brewing',
  style: 'New England IPA',
  abv: 6.4,
  ibu: 45,
  description: 'A hazy IPA.',
  barcode: '012345678905',
  source: 'wikidata',
  source_record_id: 'Q123',
  source_url: 'https://www.wikidata.org/wiki/Q123',
  retrieved_at: new Date('2026-11-23T00:00:00Z'),
  tier: '1',
  origin_bucket: 'us_produced',
  origin_evidence: [{ signal: 'wikidata_country_p495_else_p17', value: 'United States' }],
  image_url: 'https://example.com/hazy.jpg',
  image_source: 'wikidata',
  image_tier: '1',
  image_status: 'verified',
  image_status_normalized: 'verified',
  image_verified: true,
  image_flag_reason: null,
  image_license: 'CC BY-SA',
  image_page_url: 'https://example.com/page',
  image_width: 800,
  image_height: 1200,
  review_status: 'pending',
  hold_reason: null,
  hold_note: null,
  dedupe_outcome: 'no_match',
  matched_beer_id: null,
  duplicate_of_candidate_id: null,
  normalized_name: 'hazy wonder',
  normalized_brewery: 'example brewing',
  created_at: new Date('2026-11-23T00:00:00Z'),
  updated_at: new Date('2026-11-23T00:00:00Z'),
  ...overrides,
});

const groupRows = (field: string, entries: Array<[unknown, number]>) =>
  entries.map(([value, count]) => ({ [field]: value, _count: { _all: count } }));

const prismaWith = (opts: {
  batches?: any[];
  candidates?: any[];
  candidateById?: Record<number, any>;
  groups?: Record<string, any[]>;
} = {}) => ({
  discovery_batches: {
    findMany: jest.fn(async () => opts.batches || []),
    findUnique: jest.fn(async ({ where }: any) =>
      (opts.batches || []).find((b) => b.id === where.id) || null),
  },
  discovery_candidates: {
    groupBy: jest.fn(async ({ by }: any) => (opts.groups && opts.groups[by[0]]) || []),
    count: jest.fn(async () => (opts.candidates || []).length),
    findMany: jest.fn(async () => opts.candidates || []),
    findUnique: jest.fn(async ({ where }: any) =>
      opts.candidateById && opts.candidateById[where.id] ? opts.candidateById[where.id] : null),
  },
});

const appWith = (prisma: any) => createApp({ ...adminDeps, prisma } as any);
const auth = (req: request.Test) => req.set('Authorization', 'Bearer test-token');

describe('GET /discovery/batches', () => {
  it('returns grouped counts with explicit null-group keys and progress', async () => {
    const prisma = prismaWith({
      batches: [batchRow()],
      groups: {
        origin_bucket: groupRows('origin_bucket', [['us_produced', 3], [null, 1]]),
        image_status_normalized: groupRows('image_status_normalized', [['verified', 1], [null, 3]]),
        hold_reason: groupRows('hold_reason', [[null, 2], ['image_unverified', 2]]),
        review_status: groupRows('review_status', [['pending', 4]]),
      },
    });
    const res = await auth(request(appWith(prisma)).get('/admin-api/v1/discovery/batches'));
    expect(res.status).toBe(200);
    const batch = res.body.results[0];
    expect(batch.record_count).toBe(4);
    expect(batch.counts.by_origin_bucket).toEqual({ us_produced: 3, not_classified: 1 });
    expect(batch.counts.by_image_status).toEqual({ verified: 1, not_staged: 3 });
    expect(batch.counts.by_hold_reason).toEqual({ none: 2, image_unverified: 2 });
    expect(batch.review_progress).toEqual({ total: 4, decided: 0, pending: 4, percent_reviewed: 0 });
  });

  it('returns 401 without a token', async () => {
    const res = await request(appWith(prismaWith())).get('/admin-api/v1/discovery/batches');
    expect(res.status).toBe(401);
  });
});

describe('GET /discovery/batches/:id/candidates', () => {
  it('returns the shared list envelope', async () => {
    const prisma = prismaWith({ batches: [batchRow()], candidates: [candidateRow()] });
    const res = await auth(request(appWith(prisma)).get('/admin-api/v1/discovery/batches/1/candidates'));
    expect(res.status).toBe(200);
    expect(res.body.pagination).toEqual({ page: 1, page_size: 25, total_results: 1, total_pages: 1 });
    expect(res.body.results[0]).toMatchObject({
      id: 11, name: 'Hazy Wonder', origin_bucket: 'us_produced',
      image_status_normalized: 'verified', hold_reason: null, review_status: 'pending',
    });
    // List rows never carry the verbatim payload.
    expect(res.body.results[0].payload).toBeUndefined();
  });

  it('maps hold_reason=none to a null filter and passes filters through', async () => {
    const prisma = prismaWith({ batches: [batchRow()], candidates: [] });
    const res = await auth(request(appWith(prisma)).get(
      '/admin-api/v1/discovery/batches/1/candidates?hold_reason=none&origin_bucket=us_market&image_status=not_staged&source=wikidata&q=hazy'));
    expect(res.status).toBe(200);
    const where = (prisma.discovery_candidates.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.hold_reason).toBeNull();
    expect(where.origin_bucket).toBe('us_market');
    expect(where.image_status_normalized).toBeNull();
    expect(where.source).toBe('wikidata');
    expect(where.OR).toHaveLength(2);
  });

  it('rejects an unknown filter value with 400', async () => {
    const prisma = prismaWith({ batches: [batchRow()] });
    const res = await auth(request(appWith(prisma)).get('/admin-api/v1/discovery/batches/1/candidates?origin_bucket=mars'));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_parameter');
  });

  it('rejects an unknown hold reason with 400', async () => {
    const prisma = prismaWith({ batches: [batchRow()] });
    const res = await auth(request(appWith(prisma)).get('/admin-api/v1/discovery/batches/1/candidates?hold_reason=whatever'));
    expect(res.status).toBe(400);
  });

  it('rejects a non-allowlisted sort field with 400', async () => {
    const prisma = prismaWith({ batches: [batchRow()] });
    const res = await auth(request(appWith(prisma)).get('/admin-api/v1/discovery/batches/1/candidates?sort=barcode'));
    expect(res.status).toBe(400);
  });

  it('rejects an out-of-range page_size with 400', async () => {
    const prisma = prismaWith({ batches: [batchRow()] });
    const res = await auth(request(appWith(prisma)).get('/admin-api/v1/discovery/batches/1/candidates?page_size=101'));
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown batch', async () => {
    const prisma = prismaWith({ batches: [] });
    const res = await auth(request(appWith(prisma)).get('/admin-api/v1/discovery/batches/99/candidates'));
    expect(res.status).toBe(404);
  });
});

describe('GET /discovery/candidates/:id', () => {
  it('returns full detail with provenance, evidence, and pairs', async () => {
    const detail = candidateRow({
      batch: { id: 1, slug: 'reassessment-us', title: 'Reassessment: US priority' },
      pairs_as_candidate: [{
        id: 5, candidate_id: 11, candidate_id_b: null,
        external_ref: 'craftcans_github:958', comparison: 'off_vs_craftcans512',
        method: 'fuzzy', score: 50.6, status: 'pending', rival: null,
      }],
    });
    const prisma = prismaWith({ candidateById: { 11: detail } });
    const res = await auth(request(appWith(prisma)).get('/admin-api/v1/discovery/candidates/11'));
    expect(res.status).toBe(200);
    expect(res.body.source_url).toBe('https://www.wikidata.org/wiki/Q123');
    expect(res.body.origin_evidence).toEqual([{ signal: 'wikidata_country_p495_else_p17', value: 'United States' }]);
    expect(res.body.batch).toEqual({ id: 1, slug: 'reassessment-us', title: 'Reassessment: US priority' });
    expect(res.body.pairs).toHaveLength(1);
    expect(res.body.pairs[0].external_ref).toBe('craftcans_github:958');
    expect(res.body.payload).toBeUndefined();
  });

  it('returns 404 for an unknown candidate', async () => {
    const prisma = prismaWith({ candidateById: {} });
    const res = await auth(request(appWith(prisma)).get('/admin-api/v1/discovery/candidates/77'));
    expect(res.status).toBe(404);
  });

  it('returns 404 for a malformed id', async () => {
    const prisma = prismaWith({ candidateById: {} });
    const res = await auth(request(appWith(prisma)).get('/admin-api/v1/discovery/candidates/abc'));
    expect(res.status).toBe(404);
  });
});
