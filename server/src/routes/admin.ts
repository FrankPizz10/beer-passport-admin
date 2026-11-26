// Admin routes: overview counts, database target indicator, API key
// metadata, and Firebase accounts. All GET, all read only.
import { Router, Request, Response } from 'express';
import { sendError, forbidden, invalidParameter, notFound, conflict, serviceUnavailable } from '../errors';
import { parsePagination, paginationResult, skipFor } from '../pagination';
import * as P from '../projections';
import { getAuthVerifier, AuthVerifier } from '../firebase';
import { changeAdminAccess } from '../adminAccess';

const wrap = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response) => { fn(req, res).catch((e) => sendError(res, e)); };

export const TABLES = [
  'beers', 'breweries', 'categories', 'styles', 'collections', 'collection_beers',
  'beverage_images', 'breweries_geocode', 'users', 'user_beers', 'user_badges',
  'friends', 'notifications', 'api_keys',
] as const;

export const parseDatabaseTarget = (raw: string | undefined) => {
  if (!raw) return { host: null as string | null, port: null as number | null, database: null as string | null };
  try {
    const url = new URL(raw);
    return {
      host: url.hostname || null,
      port: url.port ? Number(url.port) : 5432,
      database: url.pathname ? url.pathname.replace(/^\//, '') : null,
    };
  } catch {
    return { host: null, port: null, database: null };
  }
};

export const createAdminRouter = (prisma: any, verifier?: AuthVerifier, accessWriter?: any) => {
  const router = Router();
  const getVerifier = () => verifier || getAuthVerifier();
  const ownerOnly = (_req: Request, res: Response, next: any) => {
    if (res.locals.adminRole !== 'owner') return sendError(res, forbidden('Owner access required.'));
    return next();
  };

  router.get('/admin/session', (_req, res) => res.json({ role: res.locals.adminRole }));

  router.get('/admin/overview', ownerOnly, wrap(async (_req, res) => {
    const counts: Record<string, number> = {};
    await Promise.all(TABLES.map(async (table) => {
      counts[table] = await prisma[table].count();
    }));
    res.json({ counts, ...counts });
  }));

  router.get('/admin/target', wrap(async (_req, res) => {
    const target = parseDatabaseTarget(process.env.DATABASE_URL);
    let firebaseConfigured = false;
    try { firebaseConfigured = getVerifier().configured; } catch { firebaseConfigured = false; }
    res.json({ ...target, firebase_configured: firebaseConfigured });
  }));

  router.get('/admin/api-keys', ownerOnly, wrap(async (req, res) => {
    const pagination = parsePagination(req.query as any);
    const [total, rows] = await Promise.all([
      prisma.api_keys.count({}),
      prisma.api_keys.findMany({ select: P.apiKeyListSelect, orderBy: { id: 'asc' }, skip: skipFor(pagination), take: pagination.pageSize }),
    ]);
    res.json({ results: rows, pagination: paginationResult(pagination.page, pagination.pageSize, total) });
  }));

  router.get('/admin/accounts', ownerOnly, wrap(async (_req, res) => {
    const results = await prisma.$queryRaw`SELECT u.uid, u.email, u.user_name, g.granted_at FROM admin_access_grants g JOIN users u ON u.uid = g.uid ORDER BY u.email`;
    res.json({ results, owner: { uid: res.locals.firebaseUid, email: res.locals.user.email || null, user_name: res.locals.user.user_name || null }, writes_enabled: Boolean(accessWriter) });
  }));

  router.get('/admin/access-events', ownerOnly, wrap(async (req, res) => {
    const pagination = parsePagination(req.query as any);
    const offset = skipFor(pagination);
    const totals: any[] = await prisma.$queryRaw`SELECT count(*)::int AS total FROM admin_access_events`;
    const results = await prisma.$queryRaw`SELECT e.id::text, e.target_uid, e.actor_uid, e.action, e.occurred_at, target.email AS target_email, actor.user_name AS actor_name FROM admin_access_events e LEFT JOIN users target ON target.uid = e.target_uid LEFT JOIN users actor ON actor.uid = e.actor_uid ORDER BY e.id DESC LIMIT ${pagination.pageSize} OFFSET ${offset}`;
    res.json({ results, pagination: paginationResult(pagination.page, pagination.pageSize, totals[0].total) });
  }));

  router.post('/admin/accounts', ownerOnly, wrap(async (req, res) => {
    if (!accessWriter) throw serviceUnavailable('Admin access changes are not configured.');
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    if (!email || email.length > 254 || !email.includes('@')) throw invalidParameter('Enter a valid account email.');
    const lookup = getVerifier().getUserByEmail;
    if (!lookup) throw serviceUnavailable('Firebase account lookup is unavailable.');
    let account: { uid: string; disabled: boolean; emailVerified: boolean };
    try { account = await lookup(email); } catch (e) {
      if ((e as any)?.code === 'auth/user-not-found') throw notFound('Firebase account not found.');
      throw e;
    }
    if (account.disabled) throw conflict('The Firebase account is disabled.');
    if (!account.emailVerified) throw conflict('The Firebase account email must be verified before access can be granted.');
    if (account.uid === process.env.ADMIN_OWNER_UID) throw conflict('The owner already has access.');
    const user = await prisma.users.findUnique({ where: { uid: account.uid }, select: { id: true } });
    if (!user) throw conflict('This account needs an existing app profile before admin access can be granted.');
    if (!await changeAdminAccess(accessWriter, account.uid, res.locals.firebaseUid, 'grant')) throw conflict('This account already has admin access.');
    res.status(201).json({ uid: account.uid, role: 'admin' });
  }));

  router.post('/admin/accounts/:uid/revoke', ownerOnly, wrap(async (req, res) => {
    if (!accessWriter) throw serviceUnavailable('Admin access changes are not configured.');
    const uid = req.params.uid;
    if (!uid || uid.length > 255) throw invalidParameter('Invalid account ID.');
    if (uid === process.env.ADMIN_OWNER_UID || uid === res.locals.firebaseUid) throw forbidden('The owner cannot be revoked here.');
    if (!await changeAdminAccess(accessWriter, uid, res.locals.firebaseUid, 'revoke')) throw notFound('Admin grant not found.');
    res.json({ uid, revoked: true });
  }));

  return router;
};
