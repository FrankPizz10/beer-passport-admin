// Authenticated private-image route. GET only, read only, mounted behind
// decodeAdminToken by app.ts like every other /admin-api/v1 route.
//
// A bare storage_key on an approved beverage_images row names a private
// storage object. The key itself is never returned to the client; this
// endpoint answers with a short-lived presigned GET URL (at most
// PRESIGN_EXPIRY_SECONDS) for the first approved private image of the
// beverage, in the same lowest-id-first order the image resolver uses,
// or 404 when the beverage has no approved private image.
import { Router, Request, Response } from 'express';
import { ApiError, sendError, notFound } from '../errors';
import { parseIdParam } from '../pagination';
import * as P from '../projections';
import { PRESIGN_EXPIRY_SECONDS, PresignGetUrl } from '../imageStorage';

const wrap = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response) => { fn(req, res).catch((e) => sendError(res, e)); };

// A storage_key that is a full http(s) URL is public and already emitted
// as image_url by the resolver; only a non-empty, non-URL key names a
// private object that needs signing.
const isBareStorageKey = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  !value.startsWith('https://') &&
  !value.startsWith('http://');

export const createImagesRouter = (
  prisma: any,
  presignGetUrl: PresignGetUrl | null,
) => {
  const router = Router();

  router.get('/images/:beverageId', wrap(async (req, res) => {
    const beverageId = parseIdParam(req.params.beverageId);
    const rows = await prisma.beverage_images.findMany({
      where: { beverage_id: beverageId, status: 'approved' },
      orderBy: { id: 'asc' },
      select: P.beverageImageStorageSelect,
    });
    const row = (rows as any[]).find((r) => isBareStorageKey(r.storage_key));
    if (!row) throw notFound('No approved private image for this beverage.');
    if (!presignGetUrl) {
      throw new ApiError(500, 'internal_error', 'Private image storage is not configured.');
    }
    const { url, expiresAt } = await presignGetUrl(row.storage_key, PRESIGN_EXPIRY_SECONDS);
    res.json({ url, expires_at: expiresAt.toISOString() });
  }));

  return router;
};
