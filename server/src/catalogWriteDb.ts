import { PrismaClient } from '@prisma/client';

let client: PrismaClient | undefined;
export function getCatalogWritePrisma(): PrismaClient | null {
  const url = process.env.DATABASE_URL_CATALOG_WRITE;
  if (!url) return null;
  if (!client) client = new PrismaClient({ datasources: { db: { url } } });
  return client;
}
