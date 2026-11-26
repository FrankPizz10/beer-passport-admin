// Private-image endpoint (GET /admin-api/v1/images/:beverageId):
// - same auth behavior as every other route (401 without a token, 403
//   for a verified non-admin token) via the shared middleware.
// - 404 when the beverage has no approved row with a bare storage_key.
// - 200 returns a presigned URL plus expires_at, with expiry at most 900
//   seconds, and never leaks the raw storage_key as a response field.
// All Prisma and signing dependencies are stubs; no AWS, no database.
import request from 'supertest';
import { createApp } from '../app';
import { PRESIGN_EXPIRY_SECONDS } from '../imageStorage';

const PRIVATE_KEY = 'private/beers/beer-7.jpg';
const SIGNED_URL = 'https://signed.example.com/presigned-object?X-Amz-Signature=test';

const adminDeps = {
  resolveAdminAccess: async (uid: string) => uid === 'u2' ? null : 'owner' as const,
  verifyIdToken: jest.fn(async () => ({ uid: 'admin-uid', user_id: 'admin-uid', admin: true })),
  findUserByUid: jest.fn(async () => ({ id: 1, uid: 'admin-uid' })),
};

const prismaWithImages = (rows: unknown[]) => ({
  beverage_images: {
    findMany: jest.fn(async () => rows),
    count: jest.fn(async () => rows.length),
    findUnique: jest.fn(async () => null),
    findFirst: jest.fn(async () => null),
  },
});

const presignOk = jest.fn(async (_key: string, expiresSeconds: number) => ({
  url: SIGNED_URL,
  expiresAt: new Date(Date.now() + expiresSeconds * 1000),
}));

const auth = (req: request.Test) => req.set('Authorization', 'Bearer <redacted>');

const appWith = (rows: unknown[], extraDeps: Record<string, unknown> = {}) =>
  createApp({
    prisma: prismaWithImages(rows) as any,
    presignGetUrl: presignOk as any,
    ...adminDeps,
    ...extraDeps,
  } as any);

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /admin-api/v1/images/:beverageId', () => {
  it('returns 401 without a token', async () => {
    const res = await request(appWith([{ id: 1, storage_key: PRIVATE_KEY }]))
      .get('/admin-api/v1/images/7');
    expect(res.status).toBe(401);
    expect(presignOk).not.toHaveBeenCalled();
  });

  it('returns 403 for a verified token without the admin claim', async () => {
    const app = appWith([{ id: 1, storage_key: PRIVATE_KEY }], {
      verifyIdToken: jest.fn(async () => ({ uid: 'u2', user_id: 'u2', admin: false })),
    });
    const res = await auth(request(app).get('/admin-api/v1/images/7'));
    expect(res.status).toBe(403);
    expect(presignOk).not.toHaveBeenCalled();
  });

  it('returns 404 when the beverage has no approved image rows', async () => {
    const res = await auth(request(appWith([])).get('/admin-api/v1/images/7'));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
    expect(presignOk).not.toHaveBeenCalled();
  });

  it('returns 404 when approved rows have no bare storage_key', async () => {
    const app = appWith([
      { id: 1, storage_key: '' },
      { id: 2, storage_key: 'https://cdn.example.com/public.jpg' },
    ]);
    const res = await auth(request(app).get('/admin-api/v1/images/7'));
    expect(res.status).toBe(404);
    expect(presignOk).not.toHaveBeenCalled();
  });

  it('returns 404 for a non-integer beverage id', async () => {
    const res = await auth(request(appWith([])).get('/admin-api/v1/images/abc'));
    expect(res.status).toBe(404);
  });

  it('returns a presigned URL with expiry at most 900 seconds and no key leakage', async () => {
    const before = Date.now();
    const res = await auth(
      request(appWith([{ id: 1, storage_key: PRIVATE_KEY }])).get('/admin-api/v1/images/7'),
    );
    expect(res.status).toBe(200);
    expect(res.body.url).toBe(SIGNED_URL);
    const expiresAt = Date.parse(res.body.expires_at);
    expect(Number.isNaN(expiresAt)).toBe(false);
    expect(expiresAt).toBeGreaterThan(before);
    expect(expiresAt - before).toBeLessThanOrEqual(PRESIGN_EXPIRY_SECONDS * 1000 + 5000);
    expect(PRESIGN_EXPIRY_SECONDS).toBeLessThanOrEqual(900);
    expect(presignOk).toHaveBeenCalledWith(PRIVATE_KEY, PRESIGN_EXPIRY_SECONDS);
    expect(res.body).not.toHaveProperty('storage_key');
    expect(JSON.stringify(res.body)).not.toContain(PRIVATE_KEY);
  });

  it('signs the first bare-key row in lowest-id order, skipping public URL keys', async () => {
    const app = appWith([
      { id: 1, storage_key: 'https://cdn.example.com/public.jpg' },
      { id: 2, storage_key: PRIVATE_KEY },
      { id: 3, storage_key: 'private/beers/other.jpg' },
    ]);
    const res = await auth(request(app).get('/admin-api/v1/images/7'));
    expect(res.status).toBe(200);
    expect(presignOk).toHaveBeenCalledWith(PRIVATE_KEY, PRESIGN_EXPIRY_SECONDS);
  });

  it('returns 500 when image storage is not configured', async () => {
    const app = appWith([{ id: 1, storage_key: PRIVATE_KEY }], { presignGetUrl: null });
    const res = await auth(request(app).get('/admin-api/v1/images/7'));
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('internal_error');
    expect(JSON.stringify(res.body)).not.toContain(PRIVATE_KEY);
  });
});
