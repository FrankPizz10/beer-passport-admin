// Approval queue reads (GET /admin-api/v1/images/queue), the decision
// audit list (GET /admin-api/v1/images/decisions), and the pending
// private-image preview (GET /admin-api/v1/images/:id/preview-url):
// - same auth behavior as every other route (401 without a token, 403
//   for a verified non-admin token) via the shared middleware.
// - the queue serializer derives image_url from the storage_key ONLY
//   (source_url is a provenance page, never a direct image URL), flags
//   bare keys as has_private_image, and never leaks the raw key.
// - decisions expose who decided as users id + user_name, never the
//   Firebase UID.
// - preview-url signs only PENDING rows with a bare key; anything else
//   is a 404 and the key never appears in a response.
// All Prisma and signing dependencies are stubs; no AWS, no database.
import request from 'supertest';
import { createApp } from '../app';
import { PRESIGN_EXPIRY_SECONDS } from '../imageStorage';

const PRIVATE_KEY = 'private/beers/pending-9.jpg';
const HOSTED_URL = 'https://cdn.example.com/beers/hosted-10.jpg';
const SIGNED_URL = 'https://signed.example.com/presigned-object?X-Amz-Signature=test';

const adminDeps = {
  resolveAdminAccess: async (uid: string) => uid === 'u2' ? null : 'owner' as const,
  verifyIdToken: jest.fn(async () => ({ uid: 'admin-uid', user_id: 'admin-uid', admin: true })),
  findUserByUid: jest.fn(async () => ({ id: 1, uid: 'admin-uid' })),
};

const queueRow = (overrides: Record<string, unknown> = {}) => ({
  id: 9,
  beverage_id: 7,
  source_type: 'openfoodfacts',
  source_url: 'https://world.openfoodfacts.org/product/123',
  storage_key: PRIVATE_KEY,
  license_type: 'CC BY-SA',
  attribution: 'Open Food Facts',
  license_url: 'https://example.com/license',
  status: 'pending',
  verified_at: null,
  reviewed_by: null,
  reviewed_by_uid: null,
  reviewed_at: null,
  source_content_type: null,
  source_checked_at: null,
  source_check_status: 'unchecked',
  created_at: new Date('2026-11-20T00:00:00Z'),
  updated_at: new Date('2026-11-20T00:00:00Z'),
  beers: { id: 7, name: 'Queue Beer', brewery: { id: 3, name: 'Queue Brewery' } },
  ...overrides,
});

const decisionRow = (overrides: Record<string, unknown> = {}) => ({
  id: 5,
  beverage_image_id: 9,
  beverage_id: 7,
  action: 'approve',
  from_status: 'pending',
  to_status: 'approved',
  admin_user_id: 1,
  note: 'Label matches.',
  created_at: new Date('2026-11-21T00:00:00Z'),
  admin_user: { id: 1, user_name: 'alice' },
  ...overrides,
});

const prismaWith = (opts: {
  queueRows?: any[];
  decisionRows?: any[];
  byId?: Record<number, any>;
} = {}) => ({
  beverage_images: {
    count: jest.fn(async () => (opts.queueRows || []).length),
    findMany: jest.fn(async () => opts.queueRows || []),
    findUnique: jest.fn(async ({ where }: any) =>
      opts.byId && opts.byId[where.id] ? opts.byId[where.id] : null),
    findFirst: jest.fn(async () => null),
  },
  image_review_events: {
    count: jest.fn(async () => (opts.decisionRows || []).length),
    findMany: jest.fn(async () => opts.decisionRows || []),
  },
});

const presignOk = jest.fn(async (_key: string, expiresSeconds: number) => ({
  url: SIGNED_URL,
  expiresAt: new Date(Date.now() + expiresSeconds * 1000),
}));

const auth = (req: request.Test) => req.set('Authorization', 'Bearer valid-token');

const appWith = (prisma: any, extraDeps: Record<string, unknown> = {}) =>
  createApp({ prisma, presignGetUrl: presignOk as any, ...adminDeps, ...extraDeps } as any);

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /admin-api/v1/images/queue', () => {
  it('returns 401 without a token', async () => {
    const res = await request(appWith(prismaWith())).get('/admin-api/v1/images/queue');
    expect(res.status).toBe(401);
  });

  it('returns 403 for a verified token without the admin claim', async () => {
    const app = appWith(prismaWith(), {
      verifyIdToken: jest.fn(async () => ({ uid: 'u2', user_id: 'u2', admin: false })),
    });
    const res = await auth(request(app).get('/admin-api/v1/images/queue'));
    expect(res.status).toBe(403);
  });

  it('serializes a private candidate without leaking the storage key', async () => {
    const res = await auth(
      request(appWith(prismaWith({ queueRows: [queueRow()] }))).get('/admin-api/v1/images/queue'),
    );
    expect(res.status).toBe(200);
    expect(res.body.pagination.total_results).toBe(1);
    const row = res.body.results[0];
    expect(row.beverage).toEqual({ id: 7, name: 'Queue Beer' });
    expect(row.brewery).toEqual({ id: 3, name: 'Queue Brewery' });
    expect(row.image_url).toBeNull();
    expect(row.has_private_image).toBe(true);
    expect(row.source_check_status).toBe('unchecked');
    expect(row.source_url).toBe('https://world.openfoodfacts.org/product/123');
    expect(row).not.toHaveProperty('storage_key');
    expect(JSON.stringify(res.body)).not.toContain(PRIVATE_KEY);
  });

  it('uses the hosted storage_key URL as image_url, never the source page', async () => {
    const row = queueRow({
      id: 10,
      storage_key: HOSTED_URL,
      source_check_status: 'image',
      source_content_type: 'image/jpeg',
    });
    const res = await auth(
      request(appWith(prismaWith({ queueRows: [row] }))).get('/admin-api/v1/images/queue'),
    );
    expect(res.status).toBe(200);
    const out = res.body.results[0];
    expect(out.image_url).toBe(HOSTED_URL);
    expect(out.has_private_image).toBe(false);
    expect(out.source_check_status).toBe('image');
    expect(out.source_content_type).toBe('image/jpeg');
  });

  it('queries only pending rows', async () => {
    const prisma = prismaWith({ queueRows: [] });
    const res = await auth(request(appWith(prisma)).get('/admin-api/v1/images/queue'));
    expect(res.status).toBe(200);
    expect(prisma.beverage_images.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'pending' } }),
    );
  });
});

describe('GET /admin-api/v1/images/decisions', () => {
  it('returns decisions newest first with the decider name and no uid', async () => {
    const prisma = prismaWith({ decisionRows: [decisionRow()] });
    const res = await auth(request(appWith(prisma)).get('/admin-api/v1/images/decisions'));
    expect(res.status).toBe(200);
    expect(prisma.image_review_events.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { id: 'desc' } }),
    );
    const row = res.body.results[0];
    expect(row.action).toBe('approve');
    expect(row.admin_user_id).toBe(1);
    expect(row.admin_user_name).toBe('alice');
    expect(row.note).toBe('Label matches.');
    expect(row).not.toHaveProperty('admin_uid');
    expect(JSON.stringify(res.body)).not.toContain('admin-uid');
  });

  it('returns 401 without a token', async () => {
    const res = await request(appWith(prismaWith())).get('/admin-api/v1/images/decisions');
    expect(res.status).toBe(401);
  });
});

describe('GET /admin-api/v1/images/:id/preview-url', () => {
  const pendingPrivate = { id: 9, status: 'pending', storage_key: PRIVATE_KEY };

  it('signs a pending private image and never leaks the key', async () => {
    const app = appWith(prismaWith({ byId: { 9: pendingPrivate } }));
    const res = await auth(request(app).get('/admin-api/v1/images/9/preview-url'));
    expect(res.status).toBe(200);
    expect(res.body.url).toBe(SIGNED_URL);
    expect(presignOk).toHaveBeenCalledWith(PRIVATE_KEY, PRESIGN_EXPIRY_SECONDS);
    expect(JSON.stringify(res.body)).not.toContain(PRIVATE_KEY);
  });

  it('returns 404 for an unknown image id', async () => {
    const res = await auth(request(appWith(prismaWith())).get('/admin-api/v1/images/9/preview-url'));
    expect(res.status).toBe(404);
    expect(presignOk).not.toHaveBeenCalled();
  });

  it('returns 404 when the row is not pending', async () => {
    const app = appWith(prismaWith({ byId: { 9: { ...pendingPrivate, status: 'approved' } } }));
    const res = await auth(request(app).get('/admin-api/v1/images/9/preview-url'));
    expect(res.status).toBe(404);
    expect(presignOk).not.toHaveBeenCalled();
  });

  it('returns 404 when the pending row has a public URL key instead of a private one', async () => {
    const app = appWith(prismaWith({ byId: { 9: { id: 9, status: 'pending', storage_key: HOSTED_URL } } }));
    const res = await auth(request(app).get('/admin-api/v1/images/9/preview-url'));
    expect(res.status).toBe(404);
    expect(presignOk).not.toHaveBeenCalled();
  });

  it('returns 500 when image storage is not configured', async () => {
    const app = appWith(prismaWith({ byId: { 9: pendingPrivate } }), { presignGetUrl: null });
    const res = await auth(request(app).get('/admin-api/v1/images/9/preview-url'));
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain(PRIVATE_KEY);
  });

  it('returns 401 without a token', async () => {
    const res = await request(appWith(prismaWith({ byId: { 9: pendingPrivate } })))
      .get('/admin-api/v1/images/9/preview-url');
    expect(res.status).toBe(401);
    expect(presignOk).not.toHaveBeenCalled();
  });
});
