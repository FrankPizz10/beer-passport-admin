// Express app assembly. Every route is GET-only except the image
// approval endpoints (POST /images/:id/approve and /reject) on the
// write client from writeDb.ts and the discovery review endpoints
// (POST /discovery/candidates/:id/decide,
// /discovery/pairs/:id/decide, and the image review POSTs
// /discovery/candidates/:id/image-fetches and /image-decisions) and
// the discovery manifest endpoints (POST
// /discovery/batches/:id/manifests, POST
// /discovery/manifests/:id/approve and /void) on the write client
// from discoveryWriteDb.ts; those modules are the only mutation
// surface in the server. The health route is public;
// every other /admin-api/v1 route sits behind decodeAdminToken.
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { getPrisma } from './db';
import { getWritePrisma } from './writeDb';
import { getDiscoveryWritePrisma } from './discoveryWriteDb';
import { getAuthVerifier, AuthVerifier } from './firebase';
import { createDecodeAdminToken, defaultFindUserByUid } from './middleware/decodeAdminToken';
import decodeAdminToken from './middleware/decodeAdminToken';
import { createCatalogRouter } from './routes/catalog';
import { createUsersRouter } from './routes/users';
import { createAdminRouter } from './routes/admin';
import { createImagesRouter } from './routes/images';
import { createImageApprovalsRouter } from './routes/imageApprovals';
import { createDiscoveryRouter } from './routes/discovery';
import { createDiscoveryDecisionsRouter } from './routes/discoveryDecisions';
import { createDiscoveryImagesRouter, DiscoveryImageServices } from './routes/discoveryImages';
import { createDiscoveryManifestsRouter } from './routes/discoveryManifests';
import { getDefaultPresigner, PresignGetUrl } from './imageStorage';
import { sendError, notFound } from './errors';

export type AppDeps = {
  prisma?: any;
  writePrisma?: any;
  discoveryWritePrisma?: any;
  verifyIdToken?: (token: string) => Promise<any>;
  findUserByUid?: (uid: string) => Promise<any>;
  firebaseVerifier?: AuthVerifier;
  presignGetUrl?: PresignGetUrl | null;
  discoveryImageServices?: DiscoveryImageServices;
  discoveryManifestApproverIds?: number[];
};

export const createApp = (deps: AppDeps = {}) => {
  const app = express();
  const origin = process.env.ADMIN_ORIGIN || 'http://localhost:3000';
  app.use(cors({ origin }));
  app.use(express.json());

  app.get('/admin-api/v1/health', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  const prisma = deps.prisma || getPrisma();
  let authMiddleware: any;
  if (deps.verifyIdToken || deps.findUserByUid) {
    const verifier = deps.firebaseVerifier || getAuthVerifier();
    authMiddleware = createDecodeAdminToken({
      verifyIdToken: deps.verifyIdToken || ((token: string) => verifier.verifyIdToken(token)),
      findUserByUid: deps.findUserByUid || defaultFindUserByUid,
    });
  } else if (deps.prisma) {
    // Tests that inject only a Prisma stub still need the default user
    // lookup pointed at that stub, not at a real database.
    const verifier = deps.firebaseVerifier || getAuthVerifier();
    authMiddleware = createDecodeAdminToken({
      verifyIdToken: (token: string) => verifier.verifyIdToken(token),
      findUserByUid: async (uid: string) =>
        prisma.users.findUnique({ where: { uid }, select: { id: true, uid: true, email: true, user_name: true } }),
    });
  } else {
    authMiddleware = decodeAdminToken;
  }

  const presignGetUrl =
    deps.presignGetUrl !== undefined ? deps.presignGetUrl : getDefaultPresigner();

  // The write client is null when DATABASE_URL_WRITE is unset; the
  // approval endpoints then answer 503 and everything else is unaffected.
  const writePrisma =
    deps.writePrisma !== undefined ? deps.writePrisma : getWritePrisma();

  // Likewise null when DATABASE_URL_DISCOVERY_WRITE is unset; the
  // discovery decision endpoints then answer 503 and all browsing is
  // unaffected.
  const discoveryWritePrisma =
    deps.discoveryWritePrisma !== undefined
      ? deps.discoveryWritePrisma
      : getDiscoveryWritePrisma();

  const api = express.Router();
  api.use(authMiddleware);
  api.use(createCatalogRouter(prisma));
  api.use(createUsersRouter(prisma));
  api.use(createAdminRouter(prisma, deps.firebaseVerifier));
  api.use(createImagesRouter(prisma, presignGetUrl));
  api.use(createImageApprovalsRouter(prisma, writePrisma));
  api.use(createDiscoveryRouter(prisma));
  api.use(createDiscoveryDecisionsRouter(prisma, discoveryWritePrisma));
  if (deps.discoveryImageServices) {
    api.use(createDiscoveryImagesRouter(prisma, discoveryWritePrisma, deps.discoveryImageServices));
  } else {
    api.use(createDiscoveryImagesRouter(prisma, discoveryWritePrisma));
  }
  api.use(createDiscoveryManifestsRouter(
    prisma,
    discoveryWritePrisma,
    deps.discoveryManifestApproverIds !== undefined
      ? { approverUserIds: deps.discoveryManifestApproverIds }
      : {},
  ));
  app.use('/admin-api/v1', api);

  app.use((_req: Request, res: Response) => {
    sendError(res, notFound('Resource not found.'));
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    sendError(res, err);
  });

  return app;
};

export default createApp;
