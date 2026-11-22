// Port of decodeAdminToken from the pilot server:
// ~/workspace/workstreams/pilot-impl/repo/src/Middleware/authUsers.ts
// Phase 0 findings preserved: F-8 (a verified identity with no database
// user row must not proceed with a null user) and F-10 (an admin claim
// alone no longer grants access; the database user row is required, and a
// missing row is a 401). Behavior, status codes, and message bodies match
// the pilot function exactly. Dependencies are injected so tests can supply
// a fake token verifier and user lookup.
import { Request, Response, NextFunction } from 'express';
import { getPrisma } from '../db';
import { getAuthVerifier } from '../firebase';

export type DecodedToken = {
  uid?: string;
  user_id?: string;
  admin?: unknown;
  [key: string]: unknown;
};

export type DecodeAdminTokenDeps = {
  verifyIdToken: (token: string) => Promise<DecodedToken | null | undefined>;
  findUserByUid: (uid: string) => Promise<{ id: number } | null>;
};

const isAuthError = (e: unknown): boolean => {
  const code = (e as { code?: unknown })?.code;
  return typeof code === 'string' && code.startsWith('auth/');
};

export const createDecodeAdminToken = (deps: DecodeAdminTokenDeps) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.headers.authorization) {
      res.statusCode = 401;
      return res.json({ message: 'Unauthorized' });
    }
    const token = req.headers.authorization.split(' ')[1];
    if (!token || token === 'undefined') {
      res.statusCode = 401;
      return res.json({ message: 'Unauthorized' });
    }
    let decodeValue: DecodedToken | null | undefined;
    try {
      decodeValue = await deps.verifyIdToken(token);
    } catch (e) {
      if (isAuthError(e)) {
        res.statusCode = 401;
        return res.json({ message: 'Unauthorized' });
      }
      res.statusCode = 500;
      return res.json({ message: 'Auth Admin Internal Error' });
    }
    if (!decodeValue) {
      res.statusCode = 401;
      return res.json({ message: 'Unauthorized' });
    }
    if (!decodeValue.admin) {
      res.statusCode = 403;
      return res.json({ message: 'Unauthorized Admin' });
    }
    res.locals.firebaseUid = decodeValue.uid || decodeValue.user_id;
    let user: { id: number } | null;
    try {
      user = await deps.findUserByUid(decodeValue.user_id as string);
    } catch (e) {
      res.statusCode = 500;
      return res.json({ message: 'Auth Admin Internal Error' });
    }
    if (!user) {
      res.statusCode = 401;
      return res.json({ message: 'Unauthorized' });
    }
    res.locals.user = user;
    return next();
  };
};

export const defaultFindUserByUid = async (uid: string) => {
  const prisma = getPrisma();
  return prisma.users.findUnique({ where: { uid }, select: { id: true, uid: true, email: true, user_name: true } });
};

const decodeAdminToken = createDecodeAdminToken({
  verifyIdToken: (token: string) => getAuthVerifier().verifyIdToken(token),
  findUserByUid: defaultFindUserByUid,
});

export default decodeAdminToken;
