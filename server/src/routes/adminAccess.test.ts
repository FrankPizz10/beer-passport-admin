import request from 'supertest';
import { createApp } from '../app';

const firebase: any = {
  configured: true,
  verifyIdToken: async (token: string) => ({ uid: token }),
  listUsers: async () => ({ users: [] }),
  getUserByEmail: jest.fn(async () => ({ uid: 'reviewer', disabled: false, emailVerified: true })),
};
const tx = { $queryRaw: jest.fn(async () => []), $executeRaw: jest.fn(async () => 1) };
const writer = { $transaction: async (fn: any) => fn(tx) };
const prisma: any = {
  users: { findUnique: jest.fn(async () => ({ id: 2 })) },
  $queryRaw: jest.fn(async () => []),
};
const app = (role: 'owner' | 'admin' | null, write: any = writer) => createApp({
  prisma, adminAccessWritePrisma: write, firebaseVerifier: firebase,
  verifyIdToken: firebase.verifyIdToken,
  findUserByUid: async () => ({ id: 1 }),
  resolveAdminAccess: async () => role,
  writePrisma: null, discoveryWritePrisma: null, presignGetUrl: null,
});
const auth = (r: request.Test) => r.set('Authorization', 'Bearer owner');

beforeEach(() => { process.env.ADMIN_OWNER_UID = 'owner'; jest.clearAllMocks(); });
afterAll(() => { delete process.env.ADMIN_OWNER_UID; });

it('prevents non-owner admins from accessing account management and analytics', async () => {
  const subject = app('admin');
  expect((await auth(request(subject).get('/admin-api/v1/admin/accounts'))).status).toBe(403);
  expect((await auth(request(subject).get('/admin-api/v1/admin/access-events'))).status).toBe(403);
  expect((await auth(request(subject).get('/admin-api/v1/admin/overview'))).status).toBe(403);
  expect((await auth(request(subject).post('/admin-api/v1/admin/accounts')).send({ email: 'x@example.com' })).status).toBe(403);
  expect(firebase.getUserByEmail).not.toHaveBeenCalled();
});
it('grants an existing Firebase user with an app profile and records the change', async () => {
  const res = await auth(request(app('owner')).post('/admin-api/v1/admin/accounts')).send({ email: 'person@example.com' });
  expect(res.status).toBe(201);
  expect(res.body).toMatchObject({ uid: 'reviewer', role: 'admin' });
  expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
});
it('never lets the owner revoke itself', async () => {
  const res = await auth(request(app('owner')).post('/admin-api/v1/admin/accounts/owner/revoke'));
  expect(res.status).toBe(403);
  expect(tx.$executeRaw).not.toHaveBeenCalled();
});
it('fails closed when write access is not configured', async () => {
  const res = await auth(request(app('owner', null)).post('/admin-api/v1/admin/accounts')).send({ email: 'person@example.com' });
  expect(res.status).toBe(503);
  expect(firebase.getUserByEmail).not.toHaveBeenCalled();
});
it('refuses a grant to an unverified Firebase email', async () => {
  firebase.getUserByEmail.mockResolvedValueOnce({ uid: 'reviewer', disabled: false, emailVerified: false });
  const res = await auth(request(app('owner')).post('/admin-api/v1/admin/accounts')).send({ email: 'person@example.com' });
  expect(res.status).toBe(409);
  expect(tx.$executeRaw).not.toHaveBeenCalled();
});
it('refuses a grant without an existing app profile', async () => {
  prisma.users.findUnique.mockResolvedValueOnce(null);
  const res = await auth(request(app('owner')).post('/admin-api/v1/admin/accounts')).send({ email: 'person@example.com' });
  expect(res.status).toBe(409);
  expect(tx.$executeRaw).not.toHaveBeenCalled();
});
