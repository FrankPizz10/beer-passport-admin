// Discovery image review (hub decision 006 revision 2, issues/001
// section 4): hash-bound candidate image decisions. The reviewer
// never views the origin URL for the binding preview. The API
// fetches the staged image server-side under the documented fetch
// restrictions (src/discoveryImageFetch.ts), stores the bytes
// content-addressed (src/discoveryImageStore.ts), records every
// attempt in discovery_image_fetches, and serves the preview from
// those stored bytes. A decision names a fetch; before writing, the
// API re-hashes the stored bytes and refuses when they no longer
// match the fetch's recorded SHA-256, so a decision can only ever
// bind to the exact bytes that were previewed.
//
//   POST /admin-api/v1/discovery/candidates/:id/image-fetches
//        Fetches the candidate's staged image_url with the
//        restricted fetcher, stores the bytes on success, and
//        records the fetches row either way (201 with the fetch
//        record; the outcome field carries success or the failure
//        class). Refusals before any fetch: 503 when the discovery
//        write path or the image store is unconfigured, 404 for an
//        unknown candidate, 422 when the candidate has no fetchable
//        http(s) image URL (absent, unparseable, non-http(s), or
//        credentialed), 429 past the per-reviewer rate limit
//        (IMAGE_FETCH_RATE_LIMIT per IMAGE_FETCH_RATE_WINDOW_MS,
//        default 30 per hour, operator-configurable via
//        DISCOVERY_IMAGE_FETCH_RATE_LIMIT up to a 600 maximum; the
//        429 body carries error.retry_after_seconds, mirrored in
//        the Retry-After header).
//   GET  /admin-api/v1/discovery/candidates/:id/image-fetches
//        The candidate's fetch history (viewer role), newest first.
//   GET  /admin-api/v1/discovery/image-fetches/:fetchId/preview
//        The stored bytes for a successful fetch, served with the
//        verified content type, X-Content-Type-Options: nosniff, and
//        Content-Security-Policy: default-src 'none'; sandbox, so
//        fetched content can never execute in the admin origin. 404
//        when the fetch has no stored bytes or the object is missing
//        from the store (bytes are the evidence; re-fetch).
//   GET  /admin-api/v1/discovery/candidates/:id/image-decisions
//        The candidate's image decision history (viewer role).
//   POST /admin-api/v1/discovery/candidates/:id/image-decisions
//        {fetch_id, decision, note?, image_sha256?}
//        decision is the issues/001 vocabulary: approved / rejected.
//        Refusals: 503 unconfigured write path, 404 unknown candidate
//        or a fetch that does not belong to the candidate, 400 for a
//        malformed body, 422 when the fetch did not succeed, 409 when
//        the fetch is already decided, when a supplied image_sha256
//        does not match the fetch, or when the stored bytes no
//        longer hash to the fetch's recorded SHA-256 (including the
//        object having gone missing). On success ONE write-client
//        transaction inserts the discovery_image_decisions audit row
//        and projects the candidate's image_decision /
//        image_decision_fetch_id / image_decision_at columns; the
//        UNIQUE(fetch_id) constraint is the concurrency guard (a
//        racing decision surfaces as a 409, never a second row).
//
// Permissions: reads run on the viewer client; every write runs on
// the discovery reviewer client (DATABASE_URL_DISCOVERY_WRITE). The
// fetch performs no database writes beyond its fetches row. When the
// write client is unconfigured, the fetch and decision POSTs answer
// 503 while browsing (including preview) keeps working. Fetcher and
// decider identities come from the verified admin token
// (res.locals), never from the request body; responses serialize the
// reviewer as users id + user_name and NEVER the Firebase UID (it
// exists only in the audit columns fetched_by_uid / decided_by_uid).
import { Router, Request, Response } from 'express';
import {
  sendError, notFound, conflict, unprocessable, invalidParameter,
  serviceUnavailable, tooManyRequests,
} from '../errors';
import {
  parsePagination, parseIdParam, paginationResult, skipFor,
} from '../pagination';
import {
  fetchImageRestricted, parseFetchUrl, FetchRefusedError, sha256Hex, FetchResult,
} from '../discoveryImageFetch';
import { getDiscoveryImageStore, ImageStore } from '../discoveryImageStore';

const wrap = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response) => { fn(req, res).catch((e) => sendError(res, e)); };

export const IMAGE_DECISIONS = ['approved', 'rejected'];

// Per-reviewer image fetch rate limit: attempts counted from
// discovery_image_fetches over a rolling window (see the fetch
// handler). The default of 30 per hour is the historical behavior
// and stays in force unless an operator configures
// DISCOVERY_IMAGE_FETCH_RATE_LIMIT for high-throughput review
// sessions. Parsing rules (parseImageFetchRateLimit, exported for
// tests): unset, empty, non-numeric, fractional, zero, or negative
// values are invalid and fall back to the default (with a startup
// warning, never a silent change); values above
// IMAGE_FETCH_RATE_LIMIT_MAX are clamped to the maximum (also with
// a startup warning). The value is read once at module load, i.e.
// at server start; changing it requires an API process restart.
export const IMAGE_FETCH_RATE_LIMIT_DEFAULT = 30;
export const IMAGE_FETCH_RATE_LIMIT_MAX = 600;
export const IMAGE_FETCH_RATE_LIMIT_ENV = 'DISCOVERY_IMAGE_FETCH_RATE_LIMIT';
export const IMAGE_FETCH_RATE_WINDOW_MS = 60 * 60 * 1000;

export interface ImageFetchRateLimitConfig {
  limit: number;
  raw: string | undefined;
  source: 'default' | 'env';
  clamped: boolean;
  invalid: boolean;
}

export const parseImageFetchRateLimit = (
  env: NodeJS.ProcessEnv = process.env,
): ImageFetchRateLimitConfig => {
  const raw = env[IMAGE_FETCH_RATE_LIMIT_ENV];
  const fallback = (invalid: boolean): ImageFetchRateLimitConfig => ({
    limit: IMAGE_FETCH_RATE_LIMIT_DEFAULT, raw, source: 'default', clamped: false, invalid,
  });
  if (raw === undefined || raw.trim() === '') return fallback(false);
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return fallback(true);
  const parsed = Number.parseInt(trimmed, 10);
  if (parsed <= 0) return fallback(true);
  if (parsed > IMAGE_FETCH_RATE_LIMIT_MAX) {
    return { limit: IMAGE_FETCH_RATE_LIMIT_MAX, raw, source: 'env', clamped: true, invalid: false };
  }
  return { limit: parsed, raw, source: 'env', clamped: false, invalid: false };
};

export const IMAGE_FETCH_RATE_LIMIT_CONFIG = parseImageFetchRateLimit();
if (IMAGE_FETCH_RATE_LIMIT_CONFIG.clamped) {
  console.warn(
    `[discovery-images] ${IMAGE_FETCH_RATE_LIMIT_ENV}=${IMAGE_FETCH_RATE_LIMIT_CONFIG.raw} exceeds the maximum of ${IMAGE_FETCH_RATE_LIMIT_MAX}; clamped to ${IMAGE_FETCH_RATE_LIMIT_CONFIG.limit} fetches per reviewer per hour.`,
  );
} else if (IMAGE_FETCH_RATE_LIMIT_CONFIG.invalid) {
  console.warn(
    `[discovery-images] ${IMAGE_FETCH_RATE_LIMIT_ENV}=${JSON.stringify(IMAGE_FETCH_RATE_LIMIT_CONFIG.raw)} is not a positive integer; using the default of ${IMAGE_FETCH_RATE_LIMIT_CONFIG.limit} fetches per reviewer per hour.`,
  );
} else if (IMAGE_FETCH_RATE_LIMIT_CONFIG.source === 'env') {
  console.log(
    `[discovery-images] Image fetch rate limit configured to ${IMAGE_FETCH_RATE_LIMIT_CONFIG.limit} per reviewer per hour via ${IMAGE_FETCH_RATE_LIMIT_ENV}.`,
  );
}
export const IMAGE_FETCH_RATE_LIMIT = IMAGE_FETCH_RATE_LIMIT_CONFIG.limit;

const MAX_NOTE_LENGTH = 2000;

export interface DiscoveryImageServices {
  fetchImage: (url: string) => Promise<FetchResult>;
  store: ImageStore;
}

const defaultServices = (): DiscoveryImageServices => ({
  fetchImage: fetchImageRestricted,
  store: getDiscoveryImageStore(),
});

export const serializeImageFetch = (f: any) => ({
  id: f.id,
  candidate_id: f.candidate_id,
  image_ref: f.image_ref,
  sha256: f.sha256,
  content_type: f.content_type,
  byte_size: f.byte_size,
  width: f.width,
  height: f.height,
  outcome: f.outcome,
  outcome_detail: f.outcome_detail,
  fetched_by: f.fetcher ? { id: f.fetcher.id, user_name: f.fetcher.user_name } : null,
  fetched_at: f.fetched_at,
  decision: f.decision
    ? { id: f.decision.id, decision: f.decision.decision, decided_at: f.decision.decided_at }
    : null,
});

export const serializeImageDecision = (d: any) => ({
  id: d.id,
  candidate_id: d.candidate_id,
  fetch_id: d.fetch_id,
  image_ref: d.image_ref,
  image_sha256: d.image_sha256,
  image_content_type: d.image_content_type,
  image_width: d.image_width,
  image_height: d.image_height,
  image_source: d.image_source,
  image_license: d.image_license,
  decision: d.decision,
  note: d.note,
  decided_by: d.decider ? { id: d.decider.id, user_name: d.decider.user_name } : null,
  decided_at: d.decided_at,
});

export const createDiscoveryImagesRouter = (
  readPrisma: any,
  writePrisma: any,
  services: DiscoveryImageServices = defaultServices(),
) => {
  const router = Router();

  const actorOf = (res: Response) => ({
    adminUserId:
      res.locals.user && typeof res.locals.user.id === 'number' ? (res.locals.user.id as number) : null,
    adminUid: typeof res.locals.firebaseUid === 'string' ? (res.locals.firebaseUid as string) : null,
  });

  const requireCandidate = async (id: number) => {
    const candidate = await readPrisma.discovery_candidates.findUnique({ where: { id } });
    if (!candidate) throw notFound('Discovery candidate not found.');
    return candidate;
  };

  router.post('/discovery/candidates/:id/image-fetches', wrap(async (req: Request, res: Response) => {
    if (!writePrisma) {
      throw serviceUnavailable(
        'Discovery image fetches are not configured on this server (DATABASE_URL_DISCOVERY_WRITE is unset).',
      );
    }
    if (!services.store.configured) {
      throw serviceUnavailable(
        'Discovery image fetches are not configured on this server (DISCOVERY_IMAGE_STORE is unset).',
      );
    }
    const id = parseIdParam(req.params.id);
    const candidate = await requireCandidate(id);

    const imageRef = typeof candidate.image_url === 'string' ? candidate.image_url.trim() : '';
    if (!imageRef) {
      throw unprocessable('Discovery candidate has no staged image URL to fetch.');
    }
    try {
      parseFetchUrl(imageRef);
    } catch (e) {
      if (e instanceof FetchRefusedError) throw unprocessable(e.message);
      throw e;
    }

    const { adminUserId, adminUid } = actorOf(res);
    const since = new Date(Date.now() - IMAGE_FETCH_RATE_WINDOW_MS);
    const rateWhere = adminUserId !== null
      ? { fetched_by: adminUserId, fetched_at: { gte: since } }
      : { fetched_by_uid: adminUid, fetched_at: { gte: since } };
    const recentFetches = await readPrisma.discovery_image_fetches.count({ where: rateWhere });
    if (recentFetches >= IMAGE_FETCH_RATE_LIMIT) {
      // Machine-readable retry guidance: the window is rolling, so
      // budget returns when the OLDEST counted attempt ages out.
      // retry_after_seconds is that wait (also sent as the standard
      // Retry-After header by sendError). The fallback of a full
      // window covers the (in practice impossible) case of a count
      // at the limit with no readable oldest row.
      const oldest = await readPrisma.discovery_image_fetches.findFirst({
        where: rateWhere,
        orderBy: { fetched_at: 'asc' },
        select: { fetched_at: true },
      });
      const retryAfterSeconds = oldest
        ? Math.max(1, Math.ceil((oldest.fetched_at.getTime() + IMAGE_FETCH_RATE_WINDOW_MS - Date.now()) / 1000))
        : Math.ceil(IMAGE_FETCH_RATE_WINDOW_MS / 1000);
      throw tooManyRequests(
        `Image fetch rate limit reached (${IMAGE_FETCH_RATE_LIMIT} per reviewer per hour). Try again later.`,
        { retry_after_seconds: retryAfterSeconds },
      );
    }

    const result = await services.fetchImage(imageRef);
    // No `include` on the write-client create: the reviewer role has
    // no SELECT on users (by design), so the fetcher's display
    // identity is attached from the verified token, exactly like the
    // Phase 3 pair decision response.
    const fetcherIdentity = adminUserId !== null
      ? { id: adminUserId, user_name: res.locals.user?.user_name ?? null }
      : null;
    let row: any;
    if (result.outcome === 'success') {
      const storedSha = await services.store.put(result.image.bytes);
      if (storedSha !== result.image.sha256) {
        throw new Error('Stored image hash does not match the fetched bytes hash.');
      }
      row = await writePrisma.discovery_image_fetches.create({
        data: {
          candidate_id: id,
          image_ref: imageRef,
          sha256: result.image.sha256,
          content_type: result.image.contentType,
          byte_size: result.image.bytes.length,
          width: result.image.width,
          height: result.image.height,
          outcome: 'success',
          outcome_detail: null,
          fetched_by: adminUserId,
          fetched_by_uid: adminUid,
        },
      });
    } else {
      row = await writePrisma.discovery_image_fetches.create({
        data: {
          candidate_id: id,
          image_ref: imageRef,
          sha256: null,
          content_type: null,
          byte_size: null,
          width: null,
          height: null,
          outcome: result.outcome,
          outcome_detail: result.detail,
          fetched_by: adminUserId,
          fetched_by_uid: adminUid,
        },
      });
    }
    res.status(201).json(serializeImageFetch({ ...row, fetcher: fetcherIdentity, decision: null }));
  }));

  router.get('/discovery/candidates/:id/image-fetches', wrap(async (req: Request, res: Response) => {
    const id = parseIdParam(req.params.id);
    await requireCandidate(id);
    const pagination = parsePagination(req.query as any);
    const where = { candidate_id: id };
    const [total, rows] = await Promise.all([
      readPrisma.discovery_image_fetches.count({ where }),
      readPrisma.discovery_image_fetches.findMany({
        where,
        orderBy: [{ fetched_at: 'desc' }, { id: 'desc' }],
        skip: skipFor(pagination),
        take: pagination.pageSize,
        include: {
          fetcher: { select: { id: true, user_name: true } },
          decision: { select: { id: true, decision: true, decided_at: true } },
        },
      }),
    ]);
    res.json({
      results: rows.map(serializeImageFetch),
      pagination: paginationResult(pagination.page, pagination.pageSize, total),
    });
  }));

  router.get('/discovery/image-fetches/:fetchId/preview', wrap(async (req: Request, res: Response) => {
    const fetchId = parseIdParam(req.params.fetchId);
    const row = await readPrisma.discovery_image_fetches.findUnique({ where: { id: fetchId } });
    if (!row) throw notFound('Discovery image fetch not found.');
    if (row.outcome !== 'success' || !row.sha256) {
      throw notFound('This fetch did not produce stored image bytes; there is nothing to preview.');
    }
    if (!services.store.configured) {
      throw serviceUnavailable('The discovery image store is not configured on this server (DISCOVERY_IMAGE_STORE is unset).');
    }
    const bytes = await services.store.get(row.sha256);
    if (!bytes) {
      throw notFound(
        'The stored bytes for this fetch are missing from the image store. Re-fetch the image before deciding.',
      );
    }
    res.status(200);
    res.setHeader('Content-Type', row.content_type || 'application/octet-stream');
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(bytes);
  }));

  router.get('/discovery/candidates/:id/image-decisions', wrap(async (req: Request, res: Response) => {
    const id = parseIdParam(req.params.id);
    await requireCandidate(id);
    const pagination = parsePagination(req.query as any);
    const where = { candidate_id: id };
    const [total, rows] = await Promise.all([
      readPrisma.discovery_image_decisions.count({ where }),
      readPrisma.discovery_image_decisions.findMany({
        where,
        orderBy: [{ decided_at: 'desc' }, { id: 'desc' }],
        skip: skipFor(pagination),
        take: pagination.pageSize,
        include: { decider: { select: { id: true, user_name: true } } },
      }),
    ]);
    res.json({
      results: rows.map(serializeImageDecision),
      pagination: paginationResult(pagination.page, pagination.pageSize, total),
    });
  }));

  router.post('/discovery/candidates/:id/image-decisions', wrap(async (req: Request, res: Response) => {
    if (!writePrisma) {
      throw serviceUnavailable(
        'Discovery image decisions are not configured on this server (DATABASE_URL_DISCOVERY_WRITE is unset).',
      );
    }
    if (!services.store.configured) {
      throw serviceUnavailable(
        'Discovery image decisions are not configured on this server (DISCOVERY_IMAGE_STORE is unset).',
      );
    }
    const id = parseIdParam(req.params.id);
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const fetchIdRaw = body.fetch_id;
    if (typeof fetchIdRaw !== 'number' || !Number.isInteger(fetchIdRaw) || fetchIdRaw <= 0) {
      throw invalidParameter('fetch_id must be a positive integer naming the fetch this decision is based on.');
    }
    const decisionRaw = body.decision;
    if (typeof decisionRaw !== 'string' || !IMAGE_DECISIONS.includes(decisionRaw)) {
      throw invalidParameter(`decision must be one of: ${IMAGE_DECISIONS.join(', ')}.`);
    }
    const decision = decisionRaw;
    const noteRaw = body.note;
    const note = typeof noteRaw === 'string' && noteRaw.trim()
      ? noteRaw.trim().slice(0, MAX_NOTE_LENGTH)
      : null;
    const suppliedSha = body.image_sha256;
    if (suppliedSha !== undefined && suppliedSha !== null) {
      if (typeof suppliedSha !== 'string' || !/^[0-9a-f]{64}$/.test(suppliedSha)) {
        throw invalidParameter('image_sha256 must be a 64-character lowercase hex SHA-256.');
      }
    }

    const candidate = await requireCandidate(id);
    const fetchRow = await readPrisma.discovery_image_fetches.findUnique({
      where: { id: fetchIdRaw },
    });
    if (!fetchRow || fetchRow.candidate_id !== id) {
      throw notFound('Discovery image fetch not found for this candidate.');
    }
    if (fetchRow.outcome !== 'success' || !fetchRow.sha256) {
      throw unprocessable(
        `Fetch ${fetchRow.id} did not succeed (outcome: ${fetchRow.outcome}); only a successful fetch can be decided.`,
      );
    }
    if (typeof suppliedSha === 'string' && suppliedSha !== fetchRow.sha256) {
      throw conflict(
        'The supplied image_sha256 does not match the named fetch. The decision was refused; re-check the previewed image.',
      );
    }
    const existing = await readPrisma.discovery_image_decisions.findUnique({
      where: { fetch_id: fetchRow.id },
    });
    if (existing) {
      throw conflict(`Fetch ${fetchRow.id} has already been decided (${existing.decision}); a fetch can be decided only once.`);
    }

    // Hash binding, re-verified at decision time: the stored bytes
    // must still hash to the fetch's recorded SHA-256. A missing
    // object fails the same check (there is nothing to verify).
    const bytes = await services.store.get(fetchRow.sha256);
    if (!bytes) {
      throw conflict(
        'The stored bytes for this fetch are missing from the image store, so the hash binding cannot be verified. Re-fetch the image and decide on the new fetch.',
      );
    }
    const actualSha = sha256Hex(bytes);
    if (actualSha !== fetchRow.sha256) {
      throw conflict(
        'The stored bytes no longer match the fetch\'s recorded SHA-256 (hash mismatch). The decision was refused; re-fetch the image and decide on the new fetch.',
      );
    }

    const { adminUserId, adminUid } = actorOf(res);
    const now = new Date();
    let created: any;
    try {
      await writePrisma.$transaction(async (tx: any) => {
        created = await tx.discovery_image_decisions.create({
          data: {
            candidate_id: id,
            fetch_id: fetchRow.id,
            image_ref: fetchRow.image_ref,
            image_sha256: fetchRow.sha256,
            image_content_type: fetchRow.content_type,
            image_width: fetchRow.width,
            image_height: fetchRow.height,
            image_source: candidate.image_source ?? null,
            image_license: candidate.image_license ?? null,
            decision,
            note,
            decided_by: adminUserId,
            decided_by_uid: adminUid,
            decided_at: now,
          },
        });
        const updated = await tx.discovery_candidates.updateMany({
          where: { id },
          data: {
            image_decision: decision,
            image_decision_fetch_id: fetchRow.id,
            image_decision_at: now,
            updated_at: now,
          },
        });
        if (!updated || updated.count !== 1) {
          throw conflict(`Discovery candidate ${id} changed while the image decision was being recorded.`);
        }
      });
    } catch (e: any) {
      if (e && e.code === 'P2002') {
        throw conflict(`Fetch ${fetchRow.id} has already been decided; a fetch can be decided only once.`);
      }
      throw e;
    }

    res.status(201).json(serializeImageDecision({
      ...created,
      decider: adminUserId !== null
        ? { id: adminUserId, user_name: res.locals.user?.user_name ?? null }
        : null,
    }));
  }));

  return router;
};
