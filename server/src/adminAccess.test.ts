import { resolveAdminAccess, changeAdminAccess } from './adminAccess';

describe('admin access', () => {
  it('requires an explicit owner and resolves the configured owner by UID', async () => {
    const db = { $queryRaw: jest.fn() };
    await expect(resolveAdminAccess(db, 'owner', undefined)).rejects.toThrow('ADMIN_OWNER_UID');
    await expect(resolveAdminAccess(db, 'owner', 'owner')).resolves.toBe('owner');
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
  it('checks current grants rather than token claims', async () => {
    const db = { $queryRaw: jest.fn().mockResolvedValueOnce([{ uid: 'reviewer' }]).mockResolvedValueOnce([]) };
    await expect(resolveAdminAccess(db, 'reviewer', 'owner')).resolves.toBe('admin');
    await expect(resolveAdminAccess(db, 'reviewer', 'owner')).resolves.toBeNull();
  });
  it('records a change and audit in the same transaction and serializes the target', async () => {
    const tx = { $queryRaw: jest.fn().mockResolvedValue([]), $executeRaw: jest.fn().mockResolvedValue(1) };
    const db = { $transaction: jest.fn(async (fn: any) => fn(tx)) };
    await expect(changeAdminAccess(db, 'reviewer', 'owner', 'grant')).resolves.toBe(true);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
  });
  it('does not record a successful audit event for a no-op change', async () => {
    const tx = { $queryRaw: jest.fn().mockResolvedValue([]), $executeRaw: jest.fn().mockResolvedValue(0) };
    const db = { $transaction: async (fn: any) => fn(tx) };
    await expect(changeAdminAccess(db, 'reviewer', 'owner', 'revoke')).resolves.toBe(false);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });
});
