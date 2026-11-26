import { PrismaClient } from '@prisma/client';

// A separate, narrowly granted connection; unset disables grant/revoke writes.
let client: PrismaClient | undefined;
export function getAdminAccessWritePrisma(): PrismaClient | null {
  const url = process.env.DATABASE_URL_ADMIN_ACCESS_WRITE;
  if (!url) return null;
  if (!client) client = new PrismaClient({ datasources: { db: { url } } });
  return client;
}
