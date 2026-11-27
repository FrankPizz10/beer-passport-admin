export type AdminAccessRole = 'owner' | 'admin';

// Owner is pinned by Firebase UID in server configuration, never by email or
// a mutable custom claim. Other grants are read fresh on every request.
export async function resolveAdminAccess(prisma: any, uid: string, ownerUid: string | undefined): Promise<AdminAccessRole | null> {
  if (!ownerUid) throw new Error('ADMIN_OWNER_UID is not configured');
  if (uid === ownerUid) return 'owner';
  const rows = await prisma.$queryRaw`SELECT uid FROM admin_access_grants WHERE uid = ${uid} LIMIT 1`;
  return rows.length ? 'admin' : null;
}

// Grant/revoke and audit are one transaction. An advisory lock serializes
// concurrent changes to the same user; duplicates are rejected, not audited
// as successful changes. This operation never touches Firebase custom claims.
export async function changeAdminAccess(prisma: any, targetUid: string, actorUid: string, action: 'grant' | 'revoke') {
  return prisma.$transaction(async (tx: any) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${targetUid}, 0))::text AS locked`;
    const changed = action === 'grant'
      ? await tx.$executeRaw`INSERT INTO admin_access_grants (uid, granted_by_uid) VALUES (${targetUid}, ${actorUid}) ON CONFLICT DO NOTHING`
      : await tx.$executeRaw`DELETE FROM admin_access_grants WHERE uid = ${targetUid}`;
    if (changed !== 1) return false;
    await tx.$executeRaw`INSERT INTO admin_access_events (target_uid, actor_uid, action) VALUES (${targetUid}, ${actorUid}, ${action})`;
    return true;
  });
}
