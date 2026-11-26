// Authenticate a Firebase identity, then authorize against current database
// grants (or the configured owner UID) and require a matching user profile.
// A Firebase custom claim alone never grants access to this API.
import { Request, Response, NextFunction } from 'express';
import { getPrisma } from '../db';
import { getAuthVerifier } from '../firebase';
import { resolveAdminAccess, AdminAccessRole } from '../adminAccess';

export type DecodedToken = {
  uid?: string;
  user_id?: string;
  admin?: unknown;
  [key: string]: unknown;
};

export type DecodeAdminTokenDeps = {
  verifyIdToken: (token: string) => Promise<DecodedToken | null | undefined>;
  findUserByUid: (uid: string) => Promise<{ id: number } | null>;
  resolveAccess: (uid: string) => Promise<AdminAccessRole | null>;
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
    const uid = decodeValue.uid || decodeValue.user_id;
    if (!uid) {
      res.statusCode = 401;
      return res.json({ message: 'Unauthorized' });
    }
    let role: AdminAccessRole | null;
    try {
      role = await deps.resolveAccess(uid);
    } catch {
      res.statusCode = 503;
      return res.json({ message: 'Admin access is unavailable' });
    }
    if (!role) {
      res.statusCode = 403;
      return res.json({ message: 'Unauthorized Admin' });
    }
    res.locals.firebaseUid = uid;
    res.locals.adminRole = role;
    let user: { id: number } | null;
    try {
      user = await deps.findUserByUid(uid);
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
  resolveAccess: (uid) => resolveAdminAccess(getPrisma(), uid, process.env.ADMIN_OWNER_UID),
});

export default decodeAdminToken;
