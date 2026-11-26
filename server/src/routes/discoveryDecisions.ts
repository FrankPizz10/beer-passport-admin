// Discovery review write path (hub decision 006, issues/001 sections
// 3 and 4): the candidate-selection gate ONLY. Image decisions and
// import manifests are later phases and have no endpoints here; no
// catalog table is ever written.
//
//   POST /admin-api/v1/discovery/candidates/:id/decide
//        {decision, reason?, note?}
//        decision is the issues/001 candidate vocabulary: select,
//        hold, reject, unhold. hold and reject REQUIRE a reason from
//        the hold-reason vocabulary (missing_brewery, origin_uncertain,
//        market_fit_uncertain, duplicate_unresolved, image_unverified,
//        metadata_incomplete, out_of_scope, other; 'other' requires a
//        note). State machine over review_status (migration 002's
//        initial state is 'pending'):
//          select : pending -> selected. A held candidate cannot be
//                   selected (unhold first), and a select is refused
//                   while an unresolved (pending) duplicate pair
//                   exists for the candidate: duplicate resolution is
//                   part of selection integrity.
//          hold   : pending | selected -> held (reason recorded in
//                   hold_reason, as issues/001 requires).
//          reject : pending | held | selected -> rejected (reason
//                   recorded in hold_reason).
//          unhold : held -> pending (hold_reason cleared).
//          rejected and superseded are final: any decision on them is
//          a 409, as is any transition not listed above.
//   POST /admin-api/v1/discovery/pairs/:id/decide {decision, note?}
//        decision is the issues/001 pair payload: same | distinct.
//        'same' marks the pair's flagged candidate as a duplicate of
//        the rival: in the same transaction the candidate's
//        review_status becomes 'superseded' and its
//        duplicate_of_candidate_id is set (NULL when the rival is an
//        external_ref in another batch). 'distinct' leaves the
//        candidate untouched. An already-decided pair is a 409.
//   GET  /admin-api/v1/discovery/candidates/:id/decisions
//   GET  /admin-api/v1/discovery/batches/:id/decisions
//        The audit trail (read-only viewer client), newest first, in
//        the shared list envelope. Pair decisions appear in the
//        candidate's history because their audit rows carry the
//        flagged candidate's id as well as the pair id.
//
// Audit: every decision writes a discovery_decisions row in the SAME
// write-client transaction as the status change (decision 006: who,
// when, from-state, to-state, and reason in the same transaction). The
// audit 'decision' value for pair decisions is the issues/001 action
// vocabulary: same -> mark_duplicate, distinct -> mark_distinct;
// from_status / to_status then record the pair status transition. The
// status predicate on each update is the concurrency guard, mirroring
// routes/imageApprovals.ts: a concurrent decision makes the update
// match zero rows and the whole transaction aborts with 409, so a
// status change and its audit row are atomic, never one without the
// other.
//
// Permission shape (see server/db/discovery-reviewer-role.sql): the
// write client connects as beerpassport_discovery_reviewer, which can
// update only the decision columns of the two staging tables and
// insert/select discovery_decisions. Pre-checks read through the READ
// client, exactly like the image approval handlers.
//
// Auth is the same decodeAdminToken middleware as every other route
// (mounted by app.ts). The decider recorded comes from that verified
// identity (res.locals.user / res.locals.firebaseUid), never from the
// request body; responses show the decider as users id + user_name and
// NEVER serialize the Firebase UID (it exists only in the audit row's
// decided_by_uid column).
//
// When DATABASE_URL_DISCOVERY_WRITE is unset the write client is null
// and both POST endpoints answer 503; browsing is unaffected.
import { Router, Request, Response } from 'express';
import {
  sendError, notFound, conflict, unprocessable, invalidParameter, serviceUnavailable,
} from '../errors';
import {
  parsePagination, parseIdParam, paginationResult, skipFor,
} from '../pagination';
import { HOLD_REASONS, serializeCandidateListRow } from './discovery';
import { parseReviewIntent, ReviewIntentError } from '../discoveryReviewIntent';

const wrap = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response) => { fn(req, res).catch((e) => sendError(res, e)); };

const MAX_NOTE_LENGTH = 2000;

export const CANDIDATE_DECISIONS = ['select', 'hold', 'reject', 'unhold'];
export const PAIR_DECISIONS = ['same', 'distinct'];
const FINAL_STATUSES = ['rejected', 'superseded'];

const parseNote = (body: unknown): string | null => {
  if (!body || typeof body !== 'object') return null;
  const raw = (body as { note?: unknown }).note;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed.slice(0, MAX_NOTE_LENGTH) : null;
};

const parseDecision = (body: unknown, allowed: string[], label: string): string => {
  const raw = body && typeof body === 'object' ? (body as { decision?: unknown }).decision : undefined;
  if (typeof raw !== 'string' || !allowed.includes(raw)) {
    throw invalidParameter(`${label} decision must be one of: ${allowed.join(', ')}.`);
  }
  return raw;
};

// A hold or reject without a reason is refused (issues/001 acceptance
// criteria): a missing reason is a 422 (the decision is well-formed
// but cannot be applied), an unknown vocabulary value is a 400, and
// the catch-all 'other' requires the free-text note (422 without one).
const parseRequiredReason = (body: unknown, note: string | null): string => {
  const raw = body && typeof body === 'object' ? (body as { reason?: unknown }).reason : undefined;
  if (raw === undefined || raw === null || raw === '') {
    throw unprocessable('A hold or reject decision requires a reason from the hold-reason vocabulary.');
  }
  if (typeof raw !== 'string' || !HOLD_REASONS.includes(raw)) {
    throw invalidParameter(`reason must be one of: ${HOLD_REASONS.join(', ')}.`);
  }
  if (raw === 'other' && !note) {
    throw unprocessable("reason 'other' requires a note explaining the hold or rejection.");
  }
  return raw;
};

export const serializeDecision = (d: any) => ({
  id: d.id,
  candidate_id: d.candidate_id,
  candidate: d.candidate ? { name: d.candidate.name, brewery_name: d.candidate.brewery_name } : null,
  pair_id: d.pair_id,
  decision: d.decision,
  from_status: d.from_status,
  to_status: d.to_status,
  reason: d.reason,
  note: d.note,
  decided_by: d.decider ? { id: d.decider.id, user_name: d.decider.user_name } : null,
  created_at: d.created_at,
});

export const createDiscoveryDecisionsRouter = (readPrisma: any, writePrisma: any) => {
  const router = Router();

  const deciderOf = (res: Response) => ({
    adminUserId:
      res.locals.user && typeof res.locals.user.id === 'number' ? (res.locals.user.id as number) : null,
    adminUid: typeof res.locals.firebaseUid === 'string' ? (res.locals.firebaseUid as string) : null,
  });

  router.get('/discovery/candidates/:id/review-intent', wrap(async (req: Request, res: Response) => {
    const id = parseIdParam(req.params.id);
    const candidate = await readPrisma.discovery_candidates.findUnique({ where: { id }, select: { id: true } });
    if (!candidate) throw notFound('Discovery candidate not found.');
    const row = await readPrisma.discovery_review_intents.findFirst({ where: { candidate_id: id }, orderBy: { id: 'desc' } });
    res.json(row ? { id: row.id, candidate_id: id, intent: row.intent, created_at: row.created_at } : null);
  }));

  router.post('/discovery/candidates/:id/review-intent', wrap(async (req: Request, res: Response) => {
    if (!writePrisma) throw serviceUnavailable('Discovery decisions are not configured on this server.');
    const id = parseIdParam(req.params.id);
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).some(k => !['intent', 'expected_revision'].includes(k)) ||
        !('expected_revision' in body) ||
        (body.expected_revision !== null && (!Number.isSafeInteger(body.expected_revision) || body.expected_revision <= 0))) {
      throw invalidParameter('expected_revision must be null or a positive revision ID.');
    }
    let intent;
    try { intent = parseReviewIntent(body.intent); }
    catch (err) {
      if (err instanceof ReviewIntentError) throw invalidParameter(err.message);
      throw err;
    }
    const { adminUserId, adminUid } = deciderOf(res);
    const result = await writePrisma.$transaction(async (tx: any) => {
      const rows = await tx.$queryRaw`SELECT id, review_status, name, brewery_name, style, abv, ibu, barcode, description FROM discovery_candidates WHERE id = ${id} FOR UPDATE`;
      if (!rows.length) throw notFound('Discovery candidate not found.');
      if (rows[0].review_status !== 'pending') throw conflict('Review intent can only be changed while the candidate is pending.');
      if (intent.mode === 'image_only') {
        const target = await tx.beers.findUnique({ where: { id: intent.target_beer_id }, select: { id: true } });
        if (!target) throw notFound('Target beer not found.');
      }
      const previous = await tx.discovery_review_intents.findFirst({ where: { candidate_id: id }, orderBy: { id: 'desc' } });
      if ((previous?.id ?? null) !== body.expected_revision) throw conflict('Review intent changed; reload before saving.');
      const source = rows[0];
      const original = { mode: 'staged_source', beer: {
        name: source.name ?? null, brewery_name: source.brewery_name ?? null,
        style: source.style ?? null, abv: source.abv ?? null, ibu: source.ibu ?? null,
        barcode: source.barcode ?? null, description: source.description ?? null,
      } };
      return tx.discovery_review_intents.create({ data: {
        candidate_id: id, intent, previous_intent: previous?.intent ?? original,
        decided_by: adminUserId, decided_by_uid: adminUid,
      } });
    });
    res.status(201).json({ id: result.id, candidate_id: id, intent: result.intent, created_at: result.created_at });
  }));

  router.post('/discovery/candidates/:id/decide', wrap(async (req: Request, res: Response) => {
    if (!writePrisma) {
      throw serviceUnavailable(
        'Discovery decisions are not configured on this server (DATABASE_URL_DISCOVERY_WRITE is unset).',
      );
    }
    const id = parseIdParam(req.params.id);
    const decision = parseDecision(req.body, CANDIDATE_DECISIONS, 'Candidate');
    const note = parseNote(req.body);
    const reason = decision === 'hold' || decision === 'reject'
      ? parseRequiredReason(req.body, note)
      : null;

    const candidate = await readPrisma.discovery_candidates.findUnique({ where: { id } });
    if (!candidate) throw notFound('Discovery candidate not found.');
    const fromStatus: string = candidate.review_status;

    if (FINAL_STATUSES.includes(fromStatus)) {
      throw conflict(
        `Discovery candidate ${id} is already ${fromStatus}; that state is final and cannot be decided again.`,
      );
    }

    let toStatus: string;
    let holdReason: string | null;
    if (decision === 'select') {
      if (fromStatus === 'held') {
        throw conflict(
          `Discovery candidate ${id} is held (${candidate.hold_reason || 'no reason recorded'}) and a held candidate cannot be selected. Unhold it first if the hold no longer applies.`,
        );
      }
      if (fromStatus !== 'pending') {
        throw conflict(`Discovery candidate ${id} is already ${fromStatus}; only a pending candidate can be selected.`);
      }
      const unresolvedPairs = await readPrisma.discovery_candidate_pairs.count({
        where: { status: 'pending', OR: [{ candidate_id: id }, { candidate_id_b: id }] },
      });
      if (unresolvedPairs > 0) {
        throw conflict(
          `Discovery candidate ${id} has ${unresolvedPairs} unresolved duplicate pair(s); resolve them before selecting it.`,
        );
      }
      toStatus = 'selected';
      holdReason = null;
    } else if (decision === 'hold') {
      if (fromStatus !== 'pending' && fromStatus !== 'selected') {
        throw conflict(`Discovery candidate ${id} is ${fromStatus}; only a pending or selected candidate can be held.`);
      }
      toStatus = 'held';
      holdReason = reason;
    } else if (decision === 'reject') {
      toStatus = 'rejected';
      holdReason = reason;
    } else {
      // unhold
      if (fromStatus !== 'held') {
        throw conflict(`Discovery candidate ${id} is ${fromStatus}; only a held candidate can be unheld.`);
      }
      toStatus = 'pending';
      holdReason = null;
    }

    const { adminUserId, adminUid } = deciderOf(res);
    const now = new Date();
    await writePrisma.$transaction(async (tx: any) => {
      const updated = await tx.discovery_candidates.updateMany({
        where: { id, review_status: fromStatus },
        data: { review_status: toStatus, hold_reason: holdReason, updated_at: now },
      });
      if (!updated || updated.count !== 1) {
        throw conflict(`Discovery candidate ${id} was already decided by someone else.`);
      }
      await tx.discovery_decisions.create({
        data: {
          candidate_id: id,
          pair_id: null,
          decision,
          from_status: fromStatus,
          to_status: toStatus,
          reason,
          note,
          decided_by: adminUserId,
          decided_by_uid: adminUid,
        },
      });
    });

    res.json(serializeCandidateListRow({
      ...candidate,
      review_status: toStatus,
      hold_reason: holdReason,
    }));
  }));

  router.post('/discovery/pairs/:id/decide', wrap(async (req: Request, res: Response) => {
    if (!writePrisma) {
      throw serviceUnavailable(
        'Discovery decisions are not configured on this server (DATABASE_URL_DISCOVERY_WRITE is unset).',
      );
    }
    const id = parseIdParam(req.params.id);
    const decision = parseDecision(req.body, PAIR_DECISIONS, 'Pair');
    const note = parseNote(req.body);

    const pair = await readPrisma.discovery_candidate_pairs.findUnique({ where: { id } });
    if (!pair) throw notFound('Discovery candidate pair not found.');
    if (pair.status !== 'pending') {
      throw conflict(`Discovery candidate pair ${id} is already ${pair.status}; only a pending pair can be decided.`);
    }
    const candidate = await readPrisma.discovery_candidates.findUnique({
      where: { id: pair.candidate_id },
      select: { id: true, review_status: true },
    });
    if (!candidate) throw notFound('Discovery candidate not found.');
    if (decision === 'same' && FINAL_STATUSES.includes(candidate.review_status)) {
      throw conflict(
        `Discovery candidate ${pair.candidate_id} is already ${candidate.review_status}; it cannot be marked as a duplicate now.`,
      );
    }

    const { adminUserId, adminUid } = deciderOf(res);
    const now = new Date();
    const auditDecision = decision === 'same' ? 'mark_duplicate' : 'mark_distinct';
    let candidateStatus: string = candidate.review_status;
    await writePrisma.$transaction(async (tx: any) => {
      const updatedPair = await tx.discovery_candidate_pairs.updateMany({
        where: { id, status: 'pending' },
        data: { status: decision, decided_by: adminUserId, decided_at: now },
      });
      if (!updatedPair || updatedPair.count !== 1) {
        throw conflict(`Discovery candidate pair ${id} was already decided by someone else.`);
      }
      if (decision === 'same') {
        const updatedCandidate = await tx.discovery_candidates.updateMany({
          where: { id: pair.candidate_id, review_status: candidate.review_status },
          data: {
            review_status: 'superseded',
            duplicate_of_candidate_id: pair.candidate_id_b ?? null,
            updated_at: now,
          },
        });
        if (!updatedCandidate || updatedCandidate.count !== 1) {
          throw conflict(`Discovery candidate ${pair.candidate_id} changed while the pair was being decided.`);
        }
        candidateStatus = 'superseded';
      }
      await tx.discovery_decisions.create({
        data: {
          candidate_id: pair.candidate_id,
          pair_id: id,
          decision: auditDecision,
          from_status: 'pending',
          to_status: decision,
          reason: null,
          note,
          decided_by: adminUserId,
          decided_by_uid: adminUid,
        },
      });
    });

    res.json({
      id: pair.id,
      batch_id: pair.batch_id,
      candidate_id: pair.candidate_id,
      candidate_id_b: pair.candidate_id_b,
      external_ref: pair.external_ref,
      comparison: pair.comparison,
      method: pair.method,
      score: pair.score,
      status: decision,
      decided_by: adminUserId !== null ? { id: adminUserId, user_name: res.locals.user?.user_name ?? null } : null,
      decided_at: now,
      candidate_review_status: candidateStatus,
    });
  }));

  const listDecisions = async (req: Request, where: any) => {
    const pagination = parsePagination(req.query as any);
    const [total, rows] = await Promise.all([
      readPrisma.discovery_decisions.count({ where }),
      readPrisma.discovery_decisions.findMany({
        where,
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        skip: skipFor(pagination),
        take: pagination.pageSize,
        include: { decider: { select: { id: true, user_name: true } }, candidate: { select: { name: true, brewery_name: true } } },
      }),
    ]);
    return {
      results: rows.map(serializeDecision),
      pagination: paginationResult(pagination.page, pagination.pageSize, total),
    };
  };

  router.get('/discovery/candidates/:id/decisions', wrap(async (req: Request, res: Response) => {
    const id = parseIdParam(req.params.id);
    const candidate = await readPrisma.discovery_candidates.findUnique({
      where: { id }, select: { id: true },
    });
    if (!candidate) throw notFound('Discovery candidate not found.');
    res.json(await listDecisions(req, { candidate_id: id }));
  }));

  router.get('/discovery/batches/:id/decisions', wrap(async (req: Request, res: Response) => {
    const id = parseIdParam(req.params.id);
    const batch = await readPrisma.discovery_batches.findUnique({
      where: { id }, select: { id: true },
    });
    if (!batch) throw notFound('Discovery batch not found.');
    res.json(await listDecisions(req, {
      OR: [{ candidate: { batch_id: id } }, { pair: { batch_id: id } }],
    }));
  }));

  return router;
};
