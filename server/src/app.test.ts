import request from 'supertest';
import { createApp } from './app';

const adminDeps = {
  verifyIdToken: jest.fn(async () => ({ uid: 'admin-uid', user_id: 'admin-uid', admin: true })),
  findUserByUid: jest.fn(async () => ({ id: 1, uid: 'admin-uid' })),
};

const makeStubPrisma = () => {
  const emptyPage = { count: jest.fn(async () => 0), findMany: jest.fn(async () => []), findUnique: jest.fn(async () => null), findFirst: jest.fn(async () => null) };
  return {
    beers: { ...emptyPage, count: jest.fn(async () => 0), findMany: jest.fn(async () => []), findUnique: jest.fn(async () => null) },
    breweries: { ...emptyPage },
    categories: { ...emptyPage },
    styles: { ...emptyPage },
    collections: { ...emptyPage },
    collection_beers: { ...emptyPage },
    beverage_images: { ...emptyPage },
    breweries_geocode: { ...emptyPage },
    users: {
      count: jest.fn(async () => 1),
      findMany: jest.fn(async () => [{ id: 1, user_name: 'alice', email: 'alice@example.com', age: 28, private: false, created_at: new Date(), updated_at: new Date(), _count: { user_beers: 2, user_badges: 1 } }]),
      findUnique: jest.fn(async () => ({ id: 1 })),
    },
    user_beers: { ...emptyPage },
    user_badges: { ...emptyPage },
    friends: { ...emptyPage },
    notifications: { ...emptyPage },
    api_keys: {
      count: jest.fn(async () => 1),
      findMany: jest.fn(async () => [{ id: 1, name: 'k1', revoked: false, created_at: new Date(), last_used_at: null, last_mod: new Date() }]),
    },
  };
};

const auth = (req: request.Test) => req.set('Authorization', 'Bearer valid-token');

describe('app', () => {
  it('unauthenticated beers list returns 401', async () => {
    const app = createApp({ prisma: makeStubPrisma(), ...adminDeps });
    const res = await request(app).get('/admin-api/v1/catalog/beers');
    expect(res.status).toBe(401);
  });
  it('health returns 200 without auth', async () => {
    const app = createApp({ prisma: makeStubPrisma(), ...adminDeps });
    const res = await request(app).get('/admin-api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
  it('no mutation surface on catalog and users', async () => {
    const app = createApp({ prisma: makeStubPrisma(), ...adminDeps });
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      for (const path of ['/admin-api/v1/catalog/beers', '/admin-api/v1/users']) {
        const res = await auth((request(app) as any)[method](path));
        expect(res.status).toBe(404);
      }
    }
  });
  it('api-keys response contains no key field', async () => {
    const app = createApp({ prisma: makeStubPrisma(), ...adminDeps });
    const res = await auth(request(app).get('/admin-api/v1/admin/api-keys'));
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('\"key\"');
    for (const row of res.body.results) expect(row).not.toHaveProperty('key');
  });
  it('users list rows have no notification_token and no uid', async () => {
    const app = createApp({ prisma: makeStubPrisma(), ...adminDeps });
    const res = await auth(request(app).get('/admin-api/v1/users'));
    expect(res.status).toBe(200);
    for (const row of res.body.results) {
      expect(row).not.toHaveProperty('notification_token');
      expect(row).not.toHaveProperty('uid');
    }
  });
  it('accounts degrades gracefully when Firebase is not configured', async () => {
    const app = createApp({
      prisma: makeStubPrisma(), ...adminDeps,
      firebaseVerifier: { configured: false, verifyIdToken: adminDeps.verifyIdToken, listUsers: jest.fn(async () => { throw new Error('not configured'); }) } as any,
    });
    const res = await auth(request(app).get('/admin-api/v1/admin/accounts'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: [], firebase_configured: false, next_cursor: null });
  });
});
