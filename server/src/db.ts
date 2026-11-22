// Lazy Prisma singleton, modeled on the pilot Discovery db module.
// Reads DATABASE_URL from the environment via the Prisma schema datasource.
// Never instantiated at import time by route modules that receive an injected
// client in tests; getPrisma is only called on the default wiring path.
import { PrismaClient } from '@prisma/client';

let prisma: PrismaClient | undefined;

export const getPrisma = (): PrismaClient => {
  if (!prisma) {
    prisma = new PrismaClient();
  }
  return prisma;
};

export type DbClient = any;
