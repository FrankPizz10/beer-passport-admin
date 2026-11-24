// Discovery hub routes (hub decision 006, issues/001). All GET, all
// read only, all mounted behind decodeAdminToken by app.ts, all served
// by the read-only viewer Prisma client. The decision endpoints (the
// candidate-selection gate) live in routes/discoveryDecisions.ts on
// the separate discovery write client; this module stays read-only.
//
//   GET /admin-api/v1/discovery/batches
//     Every batch with record_count and grouped candidate counts by
//     origin bucket, normalized image status, hold reason, and review
//     status, plus review progress (decided vs total). Null groups are
//     reported under explicit keys so the UI never guesses: origin
//     bucket null -> 'not_classified', image status null ->
//     'not_staged', hold reason null -> 'none' (no hold).
//   GET /admin-api/v1/discovery/batches/:id/candidates
//     The shared list envelope. Search q matches name or brewery text.
//     Filters: origin_bucket, image_status (the NORMALIZED status),
//     hold_reason (including 'none' for unheld), review_status, source.
//     An unknown filter value is a 400, never a silent empty result.
//     Sort allowlist: name, brewery_name, abv.
//   GET /admin-api/v1/discovery/candidates/:id
//     Full detail: provenance, origin evidence, image fields with the
//     staged statuses preserved verbatim, hold reason and note, dedupe
//     outcome, and the candidate's pairs (with the rival's basic fields
//     when the rival is staged).
import { Router, Request, Response } from 'express';
import { sendError, notFound, invalidParameter } from '../errors';
import {
  parsePagination, parseSort, orderByFor, parseIdParam,
  paginationResult, skipFor,
} from '../pagination';

const wrap = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response) => { fn(req, res).catch((e) => sendError(res, e)); };

export const ORIGIN_BUCKETS = ['us_produced', 'us_market', 'uncertain'];
export const IMAGE_STATUSES = ['verified', 'gate_passed_unverified', 'failed', 'none'];
export const HOLD_REASONS = [
  'missing_brewery', 'origin_uncertain', 'market_fit_uncertain',
  'duplicate_unresolved', 'image_unverified', 'metadata_incomplete',
  'out_of_scope', 'other',
];
export const REVIEW_STATUSES = ['pending', 'selected', 'held', 'rejected', 'superseded'];

const enumFilter = (
  query: Record<string, unknown>,
  name: string,
  allowed: string[],
  extraAllowed: string[] = [],
): string | null => {
  const raw = query[name];
  if (raw === undefined) return null;
  const value = String(raw);
  if (!allowed.includes(value) && !extraAllowed.includes(value)) {
    throw invalidParameter(`${name} must be one of: ${[...allowed, ...extraAllowed].join(', ')}.`);
  }
  return value;
};

const countBy = (rows: Array<{ _count: { _all: number } } & Record<string, any>>, field: string, nullKey: string) => {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const key = row[field] === null || row[field] === undefined ? nullKey : String(row[field]);
    out[key] = row._count._all;
  }
  return out;
};

export const serializeCandidateListRow = (c: any) => ({
  id: c.id,
  batch_id: c.batch_id,
  candidate_key: c.candidate_key,
  name: c.name,
  brewery_name: c.brewery_name,
  style: c.style,
  abv: c.abv,
  barcode: c.barcode,
  source: c.source,
  origin_bucket: c.origin_bucket,
  image_status: c.image_status,
  image_status_normalized: c.image_status_normalized,
  image_verified: c.image_verified,
  hold_reason: c.hold_reason,
  review_status: c.review_status,
  dedupe_outcome: c.dedupe_outcome,
  matched_beer_id: c.matched_beer_id,
});

export const createDiscoveryRouter = (prisma: any) => {
  const router = Router();

  router.get('/discovery/batches', wrap(async (_req, res) => {
    const batches = await prisma.discovery_batches.findMany({ orderBy: { id: 'asc' } });
    const results = [];
    for (const batch of batches) {
      const [byOrigin, byImage, byHold, byReview] = await Promise.all([
        prisma.discovery_candidates.groupBy({ by: ['origin_bucket'], where: { batch_id: batch.id }, _count: { _all: true } }),
        prisma.discovery_candidates.groupBy({ by: ['image_status_normalized'], where: { batch_id: batch.id }, _count: { _all: true } }),
        prisma.discovery_candidates.groupBy({ by: ['hold_reason'], where: { batch_id: batch.id }, _count: { _all: true } }),
        prisma.discovery_candidates.groupBy({ by: ['review_status'], where: { batch_id: batch.id }, _count: { _all: true } }),
      ]);
      const reviewCounts = countBy(byReview, 'review_status', 'unknown');
      const pending = reviewCounts['pending'] || 0;
      const total = batch.record_count;
      const decided = Math.max(0, total - pending);
      results.push({
        id: batch.id,
        slug: batch.slug,
        title: batch.title,
        source: batch.source,
        source_summary: batch.source_summary,
        record_count: batch.record_count,
        status: batch.status,
        bundle_sha256: batch.bundle_sha256,
        ingested_at: batch.ingested_at,
        counts: {
          by_origin_bucket: countBy(byOrigin, 'origin_bucket', 'not_classified'),
          by_image_status: countBy(byImage, 'image_status_normalized', 'not_staged'),
          by_hold_reason: countBy(byHold, 'hold_reason', 'none'),
          by_review_status: reviewCounts,
        },
        review_progress: {
          total,
          decided,
          pending,
          percent_reviewed: total > 0 ? Math.round((decided / total) * 1000) / 10 : 0,
        },
      });
    }
    res.json({ results });
  }));

  router.get('/discovery/batches/:id/candidates', wrap(async (req, res) => {
    const batchId = parseIdParam(req.params.id);
    const batch = await prisma.discovery_batches.findUnique({ where: { id: batchId }, select: { id: true } });
    if (!batch) throw notFound('Discovery batch not found.');
    const pagination = parsePagination(req.query as any);
    const sort = parseSort(req.query as any, ['name', 'brewery_name', 'abv'], 'name');
    const originBucket = enumFilter(req.query as any, 'origin_bucket', ORIGIN_BUCKETS);
    const imageStatus = enumFilter(req.query as any, 'image_status', IMAGE_STATUSES, ['not_staged']);
    const holdReason = enumFilter(req.query as any, 'hold_reason', HOLD_REASONS, ['none']);
    const reviewStatus = enumFilter(req.query as any, 'review_status', REVIEW_STATUSES);
    const where: any = { batch_id: batchId };
    const q = (req.query as any).q;
    if (q) {
      where.OR = [
        { name: { contains: String(q), mode: 'insensitive' } },
        { brewery_name: { contains: String(q), mode: 'insensitive' } },
      ];
    }
    if (originBucket !== null) where.origin_bucket = originBucket;
    if (imageStatus === 'not_staged') where.image_status_normalized = null;
    else if (imageStatus !== null) where.image_status_normalized = imageStatus;
    if (holdReason === 'none') where.hold_reason = null;
    else if (holdReason !== null) where.hold_reason = holdReason;
    if (reviewStatus !== null) where.review_status = reviewStatus;
    if ((req.query as any).source) where.source = String((req.query as any).source);
    const [total, rows] = await Promise.all([
      prisma.discovery_candidates.count({ where }),
      prisma.discovery_candidates.findMany({
        where, orderBy: orderByFor(sort), skip: skipFor(pagination), take: pagination.pageSize,
      }),
    ]);
    res.json({
      results: rows.map(serializeCandidateListRow),
      pagination: paginationResult(pagination.page, pagination.pageSize, total),
    });
  }));

  router.get('/discovery/candidates/:id', wrap(async (req, res) => {
    const id = parseIdParam(req.params.id);
    const candidate = await prisma.discovery_candidates.findUnique({
      where: { id },
      include: {
        batch: { select: { id: true, slug: true, title: true } },
        pairs_as_candidate: {
          orderBy: { id: 'asc' },
          include: {
            rival: {
              select: {
                id: true, name: true, brewery_name: true, style: true, abv: true,
                barcode: true, source: true, origin_bucket: true,
                image_status_normalized: true, review_status: true,
              },
            },
            decider: { select: { id: true, user_name: true } },
          },
        },
      },
    });
    if (!candidate) throw notFound('Discovery candidate not found.');
    const { batch, pairs_as_candidate, payload, ...fields } = candidate as any;
    res.json({
      ...serializeCandidateListRow(candidate),
      ibu: fields.ibu,
      description: fields.description,
      source_record_id: fields.source_record_id,
      source_url: fields.source_url,
      retrieved_at: fields.retrieved_at,
      tier: fields.tier,
      origin_evidence: fields.origin_evidence ?? null,
      image_url: fields.image_url,
      image_source: fields.image_source,
      image_tier: fields.image_tier,
      image_flag_reason: fields.image_flag_reason,
      image_license: fields.image_license,
      image_page_url: fields.image_page_url,
      image_width: fields.image_width,
      image_height: fields.image_height,
      hold_note: fields.hold_note,
      duplicate_of_candidate_id: fields.duplicate_of_candidate_id,
      image_decision: fields.image_decision ?? null,
      image_decision_fetch_id: fields.image_decision_fetch_id ?? null,
      image_decision_at: fields.image_decision_at ?? null,
      created_at: fields.created_at,
      updated_at: fields.updated_at,
      batch: batch ? { id: batch.id, slug: batch.slug, title: batch.title } : null,
      pairs: (pairs_as_candidate || []).map((p: any) => ({
        id: p.id,
        candidate_id: p.candidate_id,
        candidate_id_b: p.candidate_id_b,
        external_ref: p.external_ref,
        comparison: p.comparison,
        method: p.method,
        score: p.score,
        status: p.status,
        decided_by: p.decider ? { id: p.decider.id, user_name: p.decider.user_name } : null,
        decided_at: p.decided_at ?? null,
        rival: p.rival ? {
          id: p.rival.id, name: p.rival.name, brewery_name: p.rival.brewery_name,
          style: p.rival.style, abv: p.rival.abv, barcode: p.rival.barcode,
          source: p.rival.source, origin_bucket: p.rival.origin_bucket,
          image_status_normalized: p.rival.image_status_normalized,
          review_status: p.rival.review_status,
        } : null,
      })),
    });
  }));

  // One pair with BOTH sides serialized for the side-by-side duplicate
  // review: the flagged candidate and the rival candidate (null when
  // the rival lives in another batch and is named by external_ref).
  router.get('/discovery/pairs/:id', wrap(async (req, res) => {
    const id = parseIdParam(req.params.id);
    const pair = await prisma.discovery_candidate_pairs.findUnique({
      where: { id },
      include: {
        candidate: true,
        rival: true,
        decider: { select: { id: true, user_name: true } },
      },
    });
    if (!pair) throw notFound('Discovery candidate pair not found.');
    const { candidate, rival, decider, ...fields } = pair as any;
    res.json({
      id: fields.id,
      batch_id: fields.batch_id,
      candidate_id: fields.candidate_id,
      candidate_id_b: fields.candidate_id_b,
      external_ref: fields.external_ref,
      comparison: fields.comparison,
      method: fields.method,
      score: fields.score,
      status: fields.status,
      decided_by: decider ? { id: decider.id, user_name: decider.user_name } : null,
      decided_at: fields.decided_at ?? null,
      created_at: fields.created_at,
      candidate: candidate ? {
        ...serializeCandidateListRow(candidate),
        source_record_id: candidate.source_record_id,
        source_url: candidate.source_url,
        image_status: candidate.image_status,
        hold_reason: candidate.hold_reason,
      } : null,
      rival: rival ? {
        ...serializeCandidateListRow(rival),
        source_record_id: rival.source_record_id,
        source_url: rival.source_url,
        image_status: rival.image_status,
        hold_reason: rival.hold_reason,
      } : null,
    });
  }));

  return router;
};
