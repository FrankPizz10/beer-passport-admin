import { createDecodeAdminToken as createMiddleware } from './decodeAdminToken';
const createDecodeAdminToken = (deps: any) => createMiddleware({ resolveAccess: async () => 'admin', ...deps });

const makeRes = () => {
  const res: any = { locals: {}, statusCode: 200 };
  res.json = jest.fn(() => res);
  return res;
};
const reqWith = (auth?: string) => ({ headers: auth ? { authorization: auth } : {} } as any);

describe('decodeAdminToken', () => {
  it('no header returns 401', async () => {
    const mw = createDecodeAdminToken({ verifyIdToken: jest.fn(), findUserByUid: jest.fn() });
    const res = makeRes(); const next = jest.fn();
    await mw(reqWith(), res, next);
    expect(res.statusCode).toBe(401);
    expect(res.json).toHaveBeenCalledWith({ message: 'Unauthorized' });
    expect(next).not.toHaveBeenCalled();
  });
  it("token 'undefined' returns 401", async () => {
    const mw = createDecodeAdminToken({ verifyIdToken: jest.fn(), findUserByUid: jest.fn() });
    const res = makeRes(); const next = jest.fn();
    await mw(reqWith('Bearer undefined'), res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
  it('auth coded verify error returns 401', async () => {
    const err: any = new Error('expired'); err.code = 'auth/id-token-expired';
    const mw = createDecodeAdminToken({ verifyIdToken: jest.fn(async () => { throw err; }), findUserByUid: jest.fn() });
    const res = makeRes(); const next = jest.fn();
    await mw(reqWith('Bearer abc'), res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
  it('generic verify error returns 500', async () => {
    const mw = createDecodeAdminToken({ verifyIdToken: jest.fn(async () => { throw new Error('boom'); }), findUserByUid: jest.fn() });
    const res = makeRes(); const next = jest.fn();
    await mw(reqWith('Bearer abc'), res, next);
    expect(res.statusCode).toBe(500);
    expect(res.json).toHaveBeenCalledWith({ message: 'Auth Admin Internal Error' });
  });
  it('valid token without admin claim returns 403', async () => {
    const mw = createDecodeAdminToken({ verifyIdToken: jest.fn(async () => ({ uid: 'u1', user_id: 'u1' })), findUserByUid: jest.fn(), resolveAccess: async () => null });
    const res = makeRes(); const next = jest.fn();
    await mw(reqWith('Bearer abc'), res, next);
    expect(res.statusCode).toBe(403);
    expect(res.json).toHaveBeenCalledWith({ message: 'Unauthorized Admin' });
  });
  it('admin claim but no database user returns 401', async () => {
    const mw = createDecodeAdminToken({
      verifyIdToken: jest.fn(async () => ({ uid: 'u1', user_id: 'u1', admin: true })),
      findUserByUid: jest.fn(async () => null),
    });
    const res = makeRes(); const next = jest.fn();
    await mw(reqWith('Bearer abc'), res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
  it('admin claim plus user row calls next and sets locals', async () => {
    const user = { id: 7 };
    const mw = createDecodeAdminToken({
      verifyIdToken: jest.fn(async () => ({ uid: 'u1', user_id: 'u1', admin: true })),
      findUserByUid: jest.fn(async () => user),
    });
    const res = makeRes(); const next = jest.fn();
    await mw(reqWith('Bearer abc'), res, next);
    expect(next).toHaveBeenCalled();
    expect(res.locals.firebaseUid).toBe('u1');
    expect(res.locals.user).toBe(user);
  });
  it('does not trust a stale admin claim after the database grant is revoked', async () => {
    const mw = createDecodeAdminToken({
      verifyIdToken: async () => ({ uid: 'u1', admin: true }),
      resolveAccess: async () => null,
      findUserByUid: jest.fn(),
    });
    const res = makeRes(); const next = jest.fn();
    await mw(reqWith('Bearer token'), res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });
  it('fails closed when the access store is unavailable', async () => {
    const mw = createDecodeAdminToken({
      verifyIdToken: async () => ({ uid: 'u1', admin: true }),
      resolveAccess: async () => { throw new Error('unavailable'); },
      findUserByUid: jest.fn(),
    });
    const res = makeRes(); const next = jest.fn();
    await mw(reqWith('Bearer token'), res, next);
    expect(res.statusCode).toBe(503);
    expect(next).not.toHaveBeenCalled();
  });
});
