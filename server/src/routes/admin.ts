// Admin routes: overview counts, database target indicator, API key
// metadata, and Firebase accounts. All GET, all read only.
import { Router, Request, Response } from 'express';
import { sendError } from '../errors';
import { parsePagination, paginationResult, skipFor } from '../pagination';
import * as P from '../projections';
import { getAuthVerifier, NotConfiguredError, AuthVerifier } from '../firebase';

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

export const createAdminRouter = (prisma: any, verifier?: AuthVerifier) => {
  const router = Router();
  const getVerifier = () => verifier || getAuthVerifier();

  router.get('/admin/overview', wrap(async (_req, res) => {
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

  router.get('/admin/api-keys', wrap(async (req, res) => {
    const pagination = parsePagination(req.query as any);
    const [total, rows] = await Promise.all([
      prisma.api_keys.count({}),
      prisma.api_keys.findMany({ select: P.apiKeyListSelect, orderBy: { id: 'asc' }, skip: skipFor(pagination), take: pagination.pageSize }),
    ]);
    res.json({ results: rows, pagination: paginationResult(pagination.page, pagination.pageSize, total) });
  }));

  router.get('/admin/accounts', wrap(async (req, res) => {
    const v = getVerifier();
    if (!v.configured) {
      res.json({ results: [], firebase_configured: false, next_cursor: null });
      return;
    }
    try {
      const cursor = (req.query as any).cursor ? String((req.query as any).cursor) : undefined;
      const result = await v.listUsers(100, cursor);
      const results = (result.users || []).map((u: any) => ({
        uid: u.uid,
        email: u.email || null,
        is_admin: Boolean(u.customClaims && u.customClaims.admin === true),
        created_at: u.metadata && u.metadata.creationTime ? u.metadata.creationTime : null,
        last_sign_in_at: u.metadata && u.metadata.lastSignInTime ? u.metadata.lastSignInTime : null,
        disabled: Boolean(u.disabled),
      }));
      res.json({ results, firebase_configured: true, next_cursor: result.pageToken || null });
      return;
    } catch (e) {
      if (e instanceof NotConfiguredError) {
        res.json({ results: [], firebase_configured: false, next_cursor: null });
        return;
      }
      throw e;
    }
  }));

  return router;
};
