// The second, narrowly scoped Prisma client: the image approval write
// path. Everything else in this server reads through the client in
// db.ts, connected as beerpassport_admin_viewer (SELECT-only; that role
// and that client are unchanged by the approval workflow).
//
// This client connects as beerpassport_admin_approver (see
// server/db/approval-role.sql): it can update only the decision columns
// of beverage_images and insert/select image_review_events, nothing
// else. It exists so the API's only two mutation endpoints
// (src/routes/imageApprovals.ts, the only module allowed to call Prisma
// mutation methods; see src/readOnlyGuard.test.ts) run under a database
// identity whose blast radius is exactly one workflow.
//
// Configuration: DATABASE_URL_WRITE. When it is unset the write path is
// disabled: getWritePrisma returns null, the approval endpoints answer
// 503, and every other route is unaffected. Unsetting the variable is
// therefore also the instant kill switch for approvals (see the
// runbook's rollback section). Never point DATABASE_URL_WRITE at the
// migration/owner identity or at the viewer role's URL.
import { PrismaClient } from '@prisma/client';

let writePrisma: PrismaClient | undefined;

export const writeConfigured = (env: NodeJS.ProcessEnv = process.env): boolean =>
  typeof env.DATABASE_URL_WRITE === 'string' && env.DATABASE_URL_WRITE.length > 0;

export const getWritePrisma = (): PrismaClient | null => {
  if (!writeConfigured()) return null;
  if (!writePrisma) {
    writePrisma = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL_WRITE as string } },
    });
  }
  return writePrisma;
};

export type WriteDbClient = any;
