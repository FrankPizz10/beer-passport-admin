// Express app assembly. Only GET routes are registered anywhere in this
// server. The health route is public; every other /admin-api/v1 route sits
// behind decodeAdminToken.
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { getPrisma } from './db';
import { getAuthVerifier, AuthVerifier } from './firebase';
import { createDecodeAdminToken, defaultFindUserByUid } from './middleware/decodeAdminToken';
import decodeAdminToken from './middleware/decodeAdminToken';
import { createCatalogRouter } from './routes/catalog';
import { createUsersRouter } from './routes/users';
import { createAdminRouter } from './routes/admin';
import { createImagesRouter } from './routes/images';
import { getDefaultPresigner, PresignGetUrl } from './imageStorage';
import { sendError, notFound } from './errors';

export type AppDeps = {
  prisma?: any;
  verifyIdToken?: (token: string) => Promise<any>;
  findUserByUid?: (uid: string) => Promise<any>;
  firebaseVerifier?: AuthVerifier;
  presignGetUrl?: PresignGetUrl | null;
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

  const api = express.Router();
  api.use(authMiddleware);
  api.use(createCatalogRouter(prisma));
  api.use(createUsersRouter(prisma));
  api.use(createAdminRouter(prisma, deps.firebaseVerifier));
  api.use(createImagesRouter(prisma, presignGetUrl));
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
