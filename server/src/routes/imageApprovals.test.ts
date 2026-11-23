// Image approval write path (POST /admin-api/v1/images/:id/approve and
// /reject), the only mutation endpoints in the API:
// - auth is the shared middleware: 401 without a token or users row,
//   403 without the admin claim, and no write is attempted either way.
// - 503 when the write path is not configured (DATABASE_URL_WRITE
//   unset, modeled here by a null write client).
// - 404 unknown image id, 409 already-decided row, 422 when approving a
//   candidate whose source check says not_image or unreachable.
// - the happy paths update the row and insert the audit event in ONE
//   transaction on the write client, recording the verified decider;
//   a zero-row update (concurrent decision) aborts with 409 and writes
//   no event.
// - storage_key never appears in any response.
// All Prisma dependencies are stubs; no database.
import request from 'supertest';
import { createApp } from '../app';

const PRIVATE_KEY = 'private/beers/pending-9.jpg';

const adminDeps = {
  verifyIdToken: jest.fn(async () => ({ uid: 'admin-uid', user_id: 'admin-uid', admin: true })),
  findUserByUid: jest.fn(async () => ({ id: 1, uid: 'admin-uid' })),
};

const pendingRow = (overrides: Record<string, unknown> = {}) => ({
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
  source_content_type: 'image/jpeg',
  source_checked_at: new Date('2026-11-20T00:00:00Z'),
  source_check_status: 'image',
  created_at: new Date('2026-11-20T00:00:00Z'),
  updated_at: new Date('2026-11-20T00:00:00Z'),
  beers: { id: 7, name: 'Queue Beer', brewery: { id: 3, name: 'Queue Brewery' } },
  ...overrides,
});

const readPrismaWith = (row: any) => ({
  beverage_images: {
    findUnique: jest.fn(async () => row),
    findMany: jest.fn(async () => []),
    count: jest.fn(async () => 0),
    findFirst: jest.fn(async () => null),
  },
  image_review_events: {
    count: jest.fn(async () => 0),
    findMany: jest.fn(async () => []),
  },
});

const makeWritePrisma = (updateCount = 1) => {
  const tx = {
    beverage_images: { updateMany: jest.fn(async () => ({ count: updateCount })) },
    image_review_events: { create: jest.fn(async () => ({ id: 99 })) },
  };
  const writePrisma = { $transaction: jest.fn(async (fn: any) => fn(tx)) };
  return { writePrisma, tx };
};

const auth = (req: request.Test) => req.set('Authorization', 'Bearer valid-token');

const appWith = (row: any, writePrisma: any, extraDeps: Record<string, unknown> = {}) =>
  createApp({
    prisma: readPrismaWith(row) as any,
    writePrisma,
    presignGetUrl: null,
    ...adminDeps,
    ...extraDeps,
  } as any);

beforeEach(() => {
  jest.clearAllMocks();
});

describe('POST /admin-api/v1/images/:id/approve', () => {
  it('returns 401 without a token and writes nothing', async () => {
    const { writePrisma } = makeWritePrisma();
    const res = await request(appWith(pendingRow(), writePrisma))
      .post('/admin-api/v1/images/9/approve')
      .send({});
    expect(res.status).toBe(401);
    expect(writePrisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns 403 for a verified token without the admin claim', async () => {
    const { writePrisma } = makeWritePrisma();
    const app = appWith(pendingRow(), writePrisma, {
      verifyIdToken: jest.fn(async () => ({ uid: 'u2', user_id: 'u2', admin: false })),
    });
    const res = await auth(request(app).post('/admin-api/v1/images/9/approve')).send({});
    expect(res.status).toBe(403);
    expect(writePrisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns 401 when the verified identity has no users row', async () => {
    const { writePrisma } = makeWritePrisma();
    const app = appWith(pendingRow(), writePrisma, {
      findUserByUid: jest.fn(async () => null),
    });
    const res = await auth(request(app).post('/admin-api/v1/images/9/approve')).send({});
    expect(res.status).toBe(401);
    expect(writePrisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns 503 when the write path is not configured', async () => {
    const res = await auth(request(appWith(pendingRow(), null)).post('/admin-api/v1/images/9/approve')).send({});
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('service_unavailable');
  });

  it('returns 404 for an unknown image id', async () => {
    const { writePrisma } = makeWritePrisma();
    const res = await auth(request(appWith(null, writePrisma)).post('/admin-api/v1/images/9/approve')).send({});
    expect(res.status).toBe(404);
    expect(writePrisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns 409 when the row is already decided', async () => {
    const { writePrisma } = makeWritePrisma();
    const app = appWith(pendingRow({ status: 'approved' }), writePrisma);
    const res = await auth(request(app).post('/admin-api/v1/images/9/approve')).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('conflict');
    expect(writePrisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns 422 when approving a not_image candidate', async () => {
    const { writePrisma } = makeWritePrisma();
    const app = appWith(pendingRow({ source_check_status: 'not_image' }), writePrisma);
    const res = await auth(request(app).post('/admin-api/v1/images/9/approve')).send({});
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('unprocessable_entity');
    expect(writePrisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns 422 when approving an unreachable candidate', async () => {
    const { writePrisma } = makeWritePrisma();
    const app = appWith(pendingRow({ source_check_status: 'unreachable' }), writePrisma);
    const res = await auth(request(app).post('/admin-api/v1/images/9/approve')).send({});
    expect(res.status).toBe(422);
    expect(writePrisma.$transaction).not.toHaveBeenCalled();
  });

  it('approves: updates the row and writes the audit event in one transaction', async () => {
    const { writePrisma, tx } = makeWritePrisma();
    const res = await auth(request(appWith(pendingRow(), writePrisma)).post('/admin-api/v1/images/9/approve'))
      .send({ note: 'Label matches the product.' });
    expect(res.status).toBe(200);
    expect(writePrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.beverage_images.updateMany).toHaveBeenCalledTimes(1);
    const updateArgs = (tx.beverage_images.updateMany as jest.Mock).mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: 9, status: 'pending' });
    expect(updateArgs.data.status).toBe('approved');
    expect(updateArgs.data.verified_at).toBeInstanceOf(Date);
    expect(updateArgs.data.reviewed_at).toBeInstanceOf(Date);
    expect(updateArgs.data.reviewed_by).toBe(1);
    expect(updateArgs.data.reviewed_by_uid).toBe('admin-uid');
    expect(tx.image_review_events.create).toHaveBeenCalledTimes(1);
    const eventArgs = (tx.image_review_events.create as jest.Mock).mock.calls[0][0];
    expect(eventArgs.data).toEqual({
      beverage_image_id: 9,
      beverage_id: 7,
      action: 'approve',
      from_status: 'pending',
      to_status: 'approved',
      admin_user_id: 1,
      admin_uid: 'admin-uid',
      note: 'Label matches the product.',
    });
    expect(res.body.status).toBe('approved');
    expect(res.body.reviewed_by).toBe(1);
    expect(res.body.verified_at).toBeTruthy();
    expect(res.body).not.toHaveProperty('storage_key');
    expect(JSON.stringify(res.body)).not.toContain(PRIVATE_KEY);
  });

  it('returns 409 and writes no event when a concurrent decision already landed', async () => {
    const { writePrisma, tx } = makeWritePrisma(0);
    const res = await auth(request(appWith(pendingRow(), writePrisma)).post('/admin-api/v1/images/9/approve')).send({});
    expect(res.status).toBe(409);
    expect(tx.image_review_events.create).not.toHaveBeenCalled();
  });
});

describe('POST /admin-api/v1/images/:id/reject', () => {
  it('rejects: clears verified_at, records the decider and the event', async () => {
    const { writePrisma, tx } = makeWritePrisma();
    const res = await auth(request(appWith(pendingRow(), writePrisma)).post('/admin-api/v1/images/9/reject'))
      .send({});
    expect(res.status).toBe(200);
    const updateArgs = (tx.beverage_images.updateMany as jest.Mock).mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: 9, status: 'pending' });
    expect(updateArgs.data.status).toBe('rejected');
    expect(updateArgs.data.verified_at).toBeNull();
    expect(updateArgs.data.reviewed_by).toBe(1);
    expect(updateArgs.data.reviewed_by_uid).toBe('admin-uid');
    const eventArgs = (tx.image_review_events.create as jest.Mock).mock.calls[0][0];
    expect(eventArgs.data.action).toBe('reject');
    expect(eventArgs.data.to_status).toBe('rejected');
    expect(eventArgs.data.note).toBeNull();
    expect(res.body.status).toBe('rejected');
    expect(res.body.verified_at).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain(PRIVATE_KEY);
  });

  it('still allows rejecting a not_image candidate', async () => {
    const { writePrisma } = makeWritePrisma();
    const app = appWith(pendingRow({ source_check_status: 'not_image' }), writePrisma);
    const res = await auth(request(app).post('/admin-api/v1/images/9/reject')).send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
  });

  it('returns 503 when the write path is not configured', async () => {
    const res = await auth(request(appWith(pendingRow(), null)).post('/admin-api/v1/images/9/reject')).send({});
    expect(res.status).toBe(503);
  });
});
