import { PrismaClient } from '@prisma/client';
import { changeAdminAccess, resolveAdminAccess } from '../src/adminAccess';

const enabled = process.env.RUN_ADMIN_ACCESS_DB_TESTS === '1';
(enabled ? describe : describe.skip)('admin access on disposable PostgreSQL', () => {
  let owner: PrismaClient;
  let writer: PrismaClient;
  beforeAll(() => {
    owner = new PrismaClient({ datasources: { db: { url: process.env.ADMIN_ACCESS_TEST_OWNER_URL } } });
    writer = new PrismaClient({ datasources: { db: { url: process.env.ADMIN_ACCESS_TEST_WRITER_URL } } });
  });
  afterAll(async () => { await owner.$disconnect(); await writer.$disconnect(); });

  it('serializes concurrent grants and immediately observes revocation', async () => {
    const uid = 'integration-reviewer';
    const results = await Promise.all([
      changeAdminAccess(writer, uid, 'owner', 'grant'),
      changeAdminAccess(writer, uid, 'owner', 'grant'),
    ]);
    expect(results.sort()).toEqual([false, true]);
    expect(await resolveAdminAccess(owner, uid, 'owner')).toBe('admin');
    const events: any[] = await owner.$queryRaw`SELECT action FROM admin_access_events WHERE target_uid = ${uid}`;
    expect(events.map((row) => row.action)).toEqual(['grant']);
    expect(await changeAdminAccess(writer, uid, 'owner', 'revoke')).toBe(true);
    expect(await resolveAdminAccess(owner, uid, 'owner')).toBeNull();
  });

  it('rolls back a grant change when audit insertion fails', async () => {
    const uid = 'integration-reviewer';
    expect(await changeAdminAccess(writer, uid, 'owner', 'grant')).toBe(true);
    // The DB check constraint rejects this invalid audit action, after the
    // grant row has been deleted inside the same transaction.
    await expect(changeAdminAccess(writer, uid, 'owner', 'invalid' as any)).rejects.toThrow();
    expect(await resolveAdminAccess(owner, uid, 'owner')).toBe('admin');
  });
});
