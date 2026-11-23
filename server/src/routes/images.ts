// Image routes. GET only, read only, mounted behind decodeAdminToken by
// app.ts like every other /admin-api/v1 route. The only mutation
// endpoints in this API (POST approve/reject) live in
// routes/imageApprovals.ts and run on the separate write client.
//
// Routes in this module:
//   GET /images/queue            pending approval candidates, paginated
//   GET /images/decisions        recent approval decisions (audit list)
//   GET /images/:id/preview-url  presigned URL for a PENDING row's
//                                private image, so a reviewer can see it
//                                before deciding (the quality gate)
//   GET /images/:beverageId     presigned URL for the beverage's first
//                                APPROVED private image (release 1.0)
//
// A bare storage_key names a private storage object. The key itself is
// never returned to the client; the presigned endpoints answer with a
// short-lived URL (at most PRESIGN_EXPIRY_SECONDS) and the queue
// serializer exposes only image_url (when the key is an http(s) URL)
// and has_private_image (when it is a bare key). Note the queue's
// image_url comes from the storage_key ONLY: source_url is the
// provenance page and is never treated as a direct image URL.
import { Router, Request, Response } from 'express';
import { ApiError, sendError, notFound } from '../errors';
import {
  parsePagination, parseSort, orderByFor, parseIdParam, paginationResult, skipFor,
} from '../pagination';
import * as P from '../projections';
import { beerRef, breweryRef, emptyToNull } from '../serialize';
import { httpUrl } from '../images';
import { PRESIGN_EXPIRY_SECONDS, PresignGetUrl } from '../imageStorage';

const wrap = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response) => { fn(req, res).catch((e) => sendError(res, e)); };

// A storage_key that is a full http(s) URL is public and already emitted
// as image_url by the resolver; only a non-empty, non-URL key names a
// private object that needs signing.
export const isBareStorageKey = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  !value.startsWith('https://') &&
  !value.startsWith('http://');

// Public shape of one beverage_images row for the approval workflow.
// storage_key and reviewed_by_uid are loaded server-side (see the
// projections) and deliberately never appear here.
export const serializeQueueRow = (row: any) => ({
  id: row.id,
  beverage_id: row.beverage_id,
  beverage: beerRef(row.beers),
  brewery: breweryRef(row.beers ? row.beers.brewery : null),
  source_type: emptyToNull(row.source_type),
  source_url: emptyToNull(row.source_url),
  license_type: emptyToNull(row.license_type),
  attribution: emptyToNull(row.attribution),
  license_url: emptyToNull(row.license_url),
  status: row.status,
  verified_at: row.verified_at ?? null,
  reviewed_by: row.reviewed_by ?? null,
  reviewed_at: row.reviewed_at ?? null,
  source_content_type: row.source_content_type ?? null,
  source_checked_at: row.source_checked_at ?? null,
  source_check_status: row.source_check_status || 'unchecked',
  image_url: httpUrl(row.storage_key),
  has_private_image: isBareStorageKey(row.storage_key),
  created_at: row.created_at,
  updated_at: row.updated_at,
});

// Public shape of one image_review_events audit row. Who decided is the
// decider's users row (id + user_name); the Firebase UID stays in the
// database audit record only.
export const serializeDecisionRow = (row: any) => ({
  id: row.id,
  beverage_image_id: row.beverage_image_id,
  beverage_id: row.beverage_id,
  action: row.action,
  from_status: row.from_status,
  to_status: row.to_status,
  admin_user_id: row.admin_user_id ?? null,
  admin_user_name: row.admin_user ? row.admin_user.user_name : null,
  note: row.note ?? null,
  created_at: row.created_at,
});

export const createImagesRouter = (
  prisma: any,
  presignGetUrl: PresignGetUrl | null,
) => {
  const router = Router();

  // Registered before /images/:beverageId so the literal segments win.
  router.get('/images/queue', wrap(async (req, res) => {
    const pagination = parsePagination(req.query as any);
    const sort = parseSort(req.query as any, ['id', 'created_at']);
    const where = { status: 'pending' };
    const [total, rows] = await Promise.all([
      prisma.beverage_images.count({ where }),
      prisma.beverage_images.findMany({
        where,
        select: P.beverageImageQueueSelect,
        orderBy: orderByFor(sort),
        skip: skipFor(pagination),
        take: pagination.pageSize,
      }),
    ]);
    res.json({
      results: (rows as any[]).map(serializeQueueRow),
      pagination: paginationResult(pagination.page, pagination.pageSize, total),
    });
  }));

  router.get('/images/decisions', wrap(async (req, res) => {
    const pagination = parsePagination(req.query as any);
    const sort = parseSort(req.query as any, ['id', 'created_at'], 'id', 'desc');
    const [total, rows] = await Promise.all([
      prisma.image_review_events.count({}),
      prisma.image_review_events.findMany({
        select: P.imageReviewEventListSelect,
        orderBy: orderByFor(sort),
        skip: skipFor(pagination),
        take: pagination.pageSize,
      }),
    ]);
    res.json({
      results: (rows as any[]).map(serializeDecisionRow),
      pagination: paginationResult(pagination.page, pagination.pageSize, total),
    });
  }));

  router.get('/images/:id/preview-url', wrap(async (req, res) => {
    const id = parseIdParam(req.params.id);
    const row = await prisma.beverage_images.findUnique({
      where: { id },
      select: P.beverageImagePreviewSelect,
    });
    if (!row || row.status !== 'pending' || !isBareStorageKey(row.storage_key)) {
      throw notFound('No pending private image for this beverage image.');
    }
    if (!presignGetUrl) {
      throw new ApiError(500, 'internal_error', 'Private image storage is not configured.');
    }
    const { url, expiresAt } = await presignGetUrl(row.storage_key, PRESIGN_EXPIRY_SECONDS);
    res.json({ url, expires_at: expiresAt.toISOString() });
  }));

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
