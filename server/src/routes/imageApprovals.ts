// Image approval write path: POST /images/:id/approve and
// POST /images/:id/reject. These are the ONLY mutation endpoints in
// this API, and this module (plus src/writeDb.ts, which only builds
// the client) is the only place Prisma mutation methods may appear;
// src/readOnlyGuard.test.ts enforces that scoping. Everything else in
// the server, including the queue and decisions reads in
// routes/images.ts, runs on the read-only viewer client.
//
// Auth is the same decodeAdminToken middleware as every other route
// (mounted by app.ts): 401 without a verified token or users row, 403
// without the admin claim. The decider recorded on the row and the
// audit event comes from that verified identity (res.locals.user /
// res.locals.firebaseUid), never from the request body.
//
// Permission shape (see server/db/approval-role.sql): the write client
// connects as beerpassport_admin_approver, which can SELECT only
// (id, beverage_id, status) of beverage_images, UPDATE only its
// decision columns, and INSERT/SELECT image_review_events. This handler
// is written to that shape:
//   - Pre-checks (404 / 409 / 422) read the row through the READ client,
//     which can see source_check_status and the rest of the row.
//   - The write transaction updates with a status='pending' predicate
//     (updateMany returns only a count, so nothing unreadable is ever
//     read back) and inserts the audit event. If a concurrent decision
//     already landed, the update matches zero rows and the whole
//     transaction aborts with 409: status change and audit event are
//     atomic, never one without the other.
//   - The response is the row's public projection, assembled from the
//     pre-check read plus the decision just written; storage_key is
//     never serialized (see serializeQueueRow).
//
// When DATABASE_URL_WRITE is unset the write client is null and both
// endpoints answer 503; the rest of the API is unaffected.
import { Router, Request, Response } from 'express';
import { sendError, notFound, conflict, unprocessable, serviceUnavailable } from '../errors';
import { parseIdParam } from '../pagination';
import * as P from '../projections';
import { serializeQueueRow } from './images';

const wrap = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response) => { fn(req, res).catch((e) => sendError(res, e)); };

const MAX_NOTE_LENGTH = 2000;

const parseNote = (body: unknown): string | null => {
  if (!body || typeof body !== 'object') return null;
  const raw = (body as { note?: unknown }).note;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed.slice(0, MAX_NOTE_LENGTH) : null;
};

export const createImageApprovalsRouter = (readPrisma: any, writePrisma: any) => {
  const router = Router();

  const decide = (action: 'approve' | 'reject') =>
    wrap(async (req: Request, res: Response) => {
      if (!writePrisma) {
        throw serviceUnavailable(
          'Image approvals are not configured on this server (DATABASE_URL_WRITE is unset).',
        );
      }
      const id = parseIdParam(req.params.id);
      const note = parseNote(req.body);

      const row = await readPrisma.beverage_images.findUnique({
        where: { id },
        select: P.beverageImageQueueSelect,
      });
      if (!row) throw notFound('Beverage image not found.');
      if (row.status !== 'pending') {
        throw conflict(
          `Beverage image ${id} is already ${row.status}; only pending images can be decided.`,
        );
      }
      if (
        action === 'approve' &&
        (row.source_check_status === 'not_image' || row.source_check_status === 'unreachable')
      ) {
        throw unprocessable(
          row.source_check_status === 'not_image'
            ? 'The candidate source URL did not verify as a direct image (it answered with a non-image content type, for example a web page), so it cannot be approved. Reject it, or reload a corrected candidate.'
            : 'The candidate source URL was unreachable when checked, so the image cannot be verified. It cannot be approved; reject it, or reload the candidate.',
        );
      }

      const adminUserId: number | null =
        res.locals.user && typeof res.locals.user.id === 'number' ? res.locals.user.id : null;
      const adminUid: string | null =
        typeof res.locals.firebaseUid === 'string' ? res.locals.firebaseUid : null;
      const now = new Date();
      const toStatus = action === 'approve' ? 'approved' : 'rejected';
      const data: Record<string, unknown> = {
        status: toStatus,
        verified_at: action === 'approve' ? now : null,
        reviewed_by: adminUserId,
        reviewed_by_uid: adminUid,
        reviewed_at: now,
      };

      await writePrisma.$transaction(async (tx: any) => {
        const updated = await tx.beverage_images.updateMany({
          where: { id, status: 'pending' },
          data,
        });
        if (!updated || updated.count !== 1) {
          throw conflict(`Beverage image ${id} was already decided by someone else.`);
        }
        await tx.image_review_events.create({
          data: {
            beverage_image_id: id,
            beverage_id: row.beverage_id,
            action,
            from_status: 'pending',
            to_status: toStatus,
            admin_user_id: adminUserId,
            admin_uid: adminUid,
            note,
          },
        });
      });

      res.json(
        serializeQueueRow({
          ...row,
          status: toStatus,
          verified_at: data.verified_at,
          reviewed_by: adminUserId,
          reviewed_at: now,
          updated_at: now,
        }),
      );
    });

  router.post('/images/:id/approve', decide('approve'));
  router.post('/images/:id/reject', decide('reject'));

  return router;
};
