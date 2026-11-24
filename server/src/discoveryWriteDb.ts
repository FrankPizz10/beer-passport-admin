// The third Prisma client: the discovery review write path. The image
// approval client lives in writeDb.ts; everything else reads through
// the client in db.ts, connected as beerpassport_admin_viewer
// (SELECT-only; that role and that client are unchanged by the
// discovery hub).
//
// This client connects as beerpassport_discovery_reviewer (see
// server/db/discovery-reviewer-role.sql): it can update only the
// decision columns of discovery_candidates and
// discovery_candidate_pairs, insert/select discovery_decisions, and
// (since the image review phase) insert/select
// discovery_image_fetches and discovery_image_decisions and update
// the candidates' image-decision state columns, nothing else. It
// exists so the discovery review endpoints
// (src/routes/discoveryDecisions.ts and
// src/routes/discoveryImages.ts, with imageApprovals.ts the only
// modules allowed to call Prisma mutation methods; see
// src/readOnlyGuard.test.ts) run under a database identity whose
// blast radius is exactly the review gates: no manifests and no
// catalog writes exist in this phase.
//
// Configuration: DATABASE_URL_DISCOVERY_WRITE. When it is unset the
// write path is disabled: getDiscoveryWritePrisma returns null, the
// decision endpoints answer 503, and every other route (including all
// discovery browsing) is unaffected. Unsetting the variable is
// therefore also the instant kill switch for decisions (see the
// runbook's rollback section). Never point
// DATABASE_URL_DISCOVERY_WRITE at the migration/owner identity, the
// viewer role's URL, or the approver role's URL.
import { PrismaClient } from '@prisma/client';

let discoveryWritePrisma: PrismaClient | undefined;

export const discoveryWriteConfigured = (env: NodeJS.ProcessEnv = process.env): boolean =>
  typeof env.DATABASE_URL_DISCOVERY_WRITE === 'string' && env.DATABASE_URL_DISCOVERY_WRITE.length > 0;

export const getDiscoveryWritePrisma = (): PrismaClient | null => {
  if (!discoveryWriteConfigured()) return null;
  if (!discoveryWritePrisma) {
    discoveryWritePrisma = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL_DISCOVERY_WRITE as string } },
    });
  }
  return discoveryWritePrisma;
};

export type DiscoveryWriteDbClient = any;
