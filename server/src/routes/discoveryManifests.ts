// Discovery import manifests (hub decision 006 revisions 1 and 2,
// issues/001-catalog-discovery-hub.md section 4): the third and final
// approval gate. This module builds immutable manifests from a
// batch's selected candidates, serves them read-only, records
// Frank's hash-bound approval, and supports voiding. It NEVER writes
// a catalog table and never imports: the import is the operator-run
// executor (server/scripts/import-discovery-manifest.ts), which
// re-verifies everything inside its own transaction and refuses to
// run unless the manifest is approved with a matching hash.
//
//   POST /admin-api/v1/discovery/batches/:id/manifests
//        Builds a draft manifest covering exactly the batch's
//        candidates whose review_status is 'selected'. Every
//        selected candidate must be import-eligible (selection
//        decision current, duplicate pairs resolved, not already in
//        the catalog, brewery resolvable, style resolvable, and -
//        where an image is attached - a current approved image
//        decision bound to a fetch hash). If any selected candidate
//        fails, the build is refused 422 with the blocking candidate
//        ids and reasons: a manifest never silently includes or
//        excludes. The catalog baseline fingerprint is computed at
//        build time and recorded in the content. 503 when the
//        discovery write path is unconfigured; 404 unknown batch;
//        422 when the batch has no selected candidates.
//   GET  /admin-api/v1/discovery/manifests (?batch_id=)
//   GET  /admin-api/v1/discovery/manifests/:id
//        Viewer-role reads. The detail carries the canonical content
//        summary (per-record candidate ids, payload hashes, image
//        fetch hashes), the recorded fingerprint, the lifecycle
//        events, and can_approve (see below). Hashes are shown in
//        full; no Firebase UID is ever serialized (builder/approver
//        appear as users id + user_name; the *_uid audit columns are
//        never selected into a response).
//   GET  /admin-api/v1/discovery/manifests/:id/export
//        The canonical manifest bytes exactly as hashed
//        (application/json, attachment), so the hash can be verified
//        offline with sha256sum before approving.
//   POST /admin-api/v1/discovery/manifests/:id/approve {sha256}
//        Frank's gate. Restricted to the allowlist in
//        DISCOVERY_MANIFEST_APPROVER_USER_IDS (a comma-separated
//        list of users.id values, matched against the caller's
//        verified users row - Postgres cannot see Firebase identity,
//        so the restriction lives in this layer). The allowlist being
//        unset means NOBODY can approve (fail closed). Refusals: 503
//        unconfigured write path, 404 unknown manifest, 403 caller
//        not allowlisted, 400 malformed sha256, 422 the supplied
//        sha256 differs from the stored manifest hash, 409 the
//        manifest is not in draft status. On success ONE write-client
//        transaction sets status, approved_by, approved_at, and
//        approved_sha256 (guarded by the draft-status predicate) and
//        appends the approve event.
//   POST /admin-api/v1/discovery/manifests/:id/void {note?}
//        draft or approved -> void, audited with a manifest event in
//        the same transaction. A voided manifest can never be
//        imported (the executor checks the status). Imported and
//        void manifests are final (409).
//
// Audit: lifecycle transitions write discovery_manifest_events rows
// in the SAME write-client transaction as the status change (the
// Phase 3/4 audit pattern). A dedicated events table (not
// discovery_decisions) because manifest events have no candidate or
// pair target - discovery_decisions requires one by CHECK
// constraint - and because the import event is written later by the
// operator identity, not the API.
//
// Permissions: reads run on the viewer client; writes run on the
// discovery reviewer client (DATABASE_URL_DISCOVERY_WRITE), whose
// grants on discovery_import_manifests are exactly INSERT + SELECT
// plus UPDATE (status, approved_by, approved_at, approved_sha256):
// this module can build, approve, and void, and can never alter
// manifest content or mark a manifest imported.
import { Router, Request, Response } from 'express';
import {
  sendError, notFound, conflict, unprocessable, invalidParameter,
  serviceUnavailable, forbidden,
} from '../errors';
import {
  parsePagination, parseIdParam, paginationResult, skipFor,
} from '../pagination';
import {
  buildManifestContent, computeCatalogFingerprint, evaluateEligibility,
  manifestIdFor, manifestSha256, canonicalManifestBytes, normalizeText, reviewPayloadSha256,
  BreweryLookup, StyleLookup, REVIEW_MANIFEST_SCHEMA,
} from '../discoveryManifestCore';
import { parseReviewIntent } from '../discoveryReviewIntent';

const wrap = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response) => { fn(req, res).catch((e) => sendError(res, e)); };

const MAX_NOTE_LENGTH = 2000;

export const MANIFEST_APPROVER_ENV = 'DISCOVERY_MANIFEST_APPROVER_USER_IDS';

// Parses the manifest approver allowlist: a comma-separated list of
// users.id integers. Unset, empty, or unparseable means an empty
// allowlist - nobody can approve (fail closed, decision 006).
export const parseApproverAllowlist = (raw: string | undefined): number[] => {
  if (!raw) return [];
  const ids: number[] = [];
  for (const part of raw.split(',')) {
    const n = Number(part.trim());
    if (Number.isInteger(n) && n > 0) ids.push(n);
  }
  return ids;
};

const actorOf = (res: Response) => ({
  adminUserId:
    res.locals.user && typeof res.locals.user.id === 'number' ? (res.locals.user.id as number) : null,
  adminUid: typeof res.locals.firebaseUid === 'string' ? (res.locals.firebaseUid as string) : null,
});

const userRef = (u: any) => (u ? { id: u.id, user_name: u.user_name } : null);

export const serializeManifestRow = (m: any, canApprove: boolean) => ({
  id: m.id,
  batch_id: m.batch_id,
  batch_slug: m.batch ? m.batch.slug : null,
  record_count: m.record_count,
  status: m.status,
  sha256: m.sha256,
  sha256_short: typeof m.sha256 === 'string' ? m.sha256.slice(0, 12) : null,
  built_by: userRef(m.builder),
  approved_by: userRef(m.approver),
  approved_at: m.approved_at ?? null,
  approved_sha256: m.approved_sha256 ?? null,
  imported_at: m.imported_at ?? null,
  created_at: m.created_at,
  can_approve: canApprove,
});

export const serializeManifestEvent = (e: any) => ({
  id: e.id,
  manifest_id: e.manifest_id,
  action: e.action,
  from_status: e.from_status,
  to_status: e.to_status,
  note: e.note,
  actor: userRef(e.actor),
  created_at: e.created_at,
});

export interface DiscoveryManifestOptions {
  approverUserIds?: number[];
}

export const createDiscoveryManifestsRouter = (
  readPrisma: any,
  writePrisma: any,
  options: DiscoveryManifestOptions = {},
) => {
  const router = Router();
  const approverIds = options.approverUserIds ?? parseApproverAllowlist(process.env[MANIFEST_APPROVER_ENV]);
  const canApprove = (res: Response): boolean => {
    const { adminUserId } = actorOf(res);
    return adminUserId !== null && approverIds.includes(adminUserId);
  };

  const requireManifest = async (id: string) => {
    const row = await readPrisma.discovery_import_manifests.findUnique({
      where: { id },
      include: {
        batch: { select: { id: true, slug: true } },
        builder: { select: { id: true, user_name: true } },
        approver: { select: { id: true, user_name: true } },
      },
    });
    if (!row) throw notFound('Discovery import manifest not found.');
    return row;
  };

  router.post('/discovery/batches/:id/manifests', wrap(async (req: Request, res: Response) => {
    if (!writePrisma) {
      throw serviceUnavailable(
        'Discovery manifests are not configured on this server (DATABASE_URL_DISCOVERY_WRITE is unset).',
      );
    }
    const batchId = parseIdParam(req.params.id);
    const batch = await readPrisma.discovery_batches.findUnique({ where: { id: batchId } });
    if (!batch) throw notFound('Discovery batch not found.');

    const selected = await readPrisma.discovery_candidates.findMany({
      where: { batch_id: batchId, review_status: 'selected' },
      orderBy: [{ candidate_key: 'asc' }, { id: 'asc' }],
    });
    if (selected.length === 0) {
      throw unprocessable(
        `Discovery batch ${batch.slug} has no selected candidates; there is nothing to build a manifest from.`,
      );
    }
    const candidateIds = selected.map((c: any) => c.id);
    const intentRows = await readPrisma.discovery_review_intents.findMany({
      where: { candidate_id: { in: candidateIds } }, orderBy: [{ id: 'desc' }],
    });
    const intentsByCandidate = new Map<number, { id: number; intent: ReturnType<typeof parseReviewIntent> }>();
    for (const row of intentRows) {
      if (!intentsByCandidate.has(row.candidate_id)) {
        intentsByCandidate.set(row.candidate_id, { id: row.id, intent: parseReviewIntent(row.intent) });
      }
    }

    // The selection decision each candidate's state rests on: the
    // latest candidate-gate decision row per candidate (pair
    // decisions excluded). It counts only when it is the 'select'
    // that set the current 'selected' status.
    const decisions = await readPrisma.discovery_decisions.findMany({
      where: { candidate_id: { in: candidateIds }, pair_id: null },
      orderBy: [{ id: 'desc' }],
    });
    const latestDecisionByCandidate = new Map<number, any>();
    for (const d of decisions) {
      if (!latestDecisionByCandidate.has(d.candidate_id)) {
        latestDecisionByCandidate.set(d.candidate_id, d);
      }
    }

    const pendingPairs = await readPrisma.discovery_candidate_pairs.findMany({
      where: {
        status: 'pending',
        OR: [{ candidate_id: { in: candidateIds } }, { candidate_id_b: { in: candidateIds } }],
      },
      select: { candidate_id: true, candidate_id_b: true },
    });
    const pairsByCandidate = new Map<number, number>();
    for (const p of pendingPairs) {
      for (const cid of [p.candidate_id, p.candidate_id_b]) {
        if (cid !== null && candidateIds.includes(cid)) {
          pairsByCandidate.set(cid, (pairsByCandidate.get(cid) || 0) + 1);
        }
      }
    }

    const fetchIds = selected
      .map((c: any) => c.image_decision_fetch_id)
      .filter((v: any): v is number => typeof v === 'number');
    const imageDecisions = fetchIds.length
      ? await readPrisma.discovery_image_decisions.findMany({ where: { fetch_id: { in: fetchIds } } })
      : [];
    const imageDecisionByFetch = new Map<number, any>();
    for (const d of imageDecisions) imageDecisionByFetch.set(d.fetch_id, d);

    const [breweryRows, styleRows] = await Promise.all([
      readPrisma.breweries.findMany({ select: { id: true, name: true, archived_at: true } }),
      readPrisma.styles.findMany({ select: { id: true, style_name: true, cat_id: true, archived_at: true } }),
    ]);
    const breweriesByNormalized = new Map<string, number[]>();
    for (const b of breweryRows) {
      const key = normalizeText(b.name);
      breweriesByNormalized.set(key, [...(breweriesByNormalized.get(key) || []), b.id]);
    }
    const stylesByNormalized = new Map<string, any[]>();
    for (const s of styleRows) {
      const key = normalizeText(s.style_name);
      stylesByNormalized.set(key, [...(stylesByNormalized.get(key) || []), s]);
    }

    const fingerprint = await computeCatalogFingerprint(
      (sql: string) => readPrisma.$queryRawUnsafe(sql),
    );

    const blockers: Array<{ candidate_id: number; candidate_key: string; reasons: string[] }> = [];
    const records = [];
    for (const staged of selected) {
      const reviewIntent = intentsByCandidate.get(staged.id) ?? null;
      const candidate = reviewIntent?.intent.mode === 'new_beer'
        ? { ...staged, ...reviewIntent.intent.beer, normalized_brewery: normalizeText(reviewIntent.intent.beer.brewery_name) }
        : staged;
      if (reviewIntent?.intent.mode === 'image_only') {
        const target = await readPrisma.beers.findUnique({ where: { id: reviewIntent.intent.target_beer_id }, select: { id: true, archived_at: true } });
        if (!target || target.archived_at) {
          blockers.push({ candidate_id: staged.id, candidate_key: staged.candidate_key, reasons: ['target_beer_missing'] });
          continue;
        }
      }
      const latest = latestDecisionByCandidate.get(candidate.id);
      const selectionDecisionId =
        latest && latest.decision === 'select' && latest.to_status === 'selected' ? latest.id : null;

      let brewery: BreweryLookup = { mode: 'new' };
      const normalizedBrewery = candidate.normalized_brewery ?? normalizeText(candidate.brewery_name);
      if (candidate.brewery_name && String(candidate.brewery_name).trim()) {
        const matches = breweriesByNormalized.get(normalizedBrewery || normalizeText(candidate.brewery_name)) || [];
        if (reviewIntent?.intent.mode !== 'image_only' && matches.length === 1 && breweryRows.some((b: any) => b.id === matches[0] && b.archived_at)) {
          blockers.push({ candidate_id: staged.id, candidate_key: staged.candidate_key, reasons: ['brewery_archived'] });
          continue;
        }
        if (matches.length === 1) brewery = { mode: 'existing', brewery_id: matches[0] };
        else if (matches.length > 1) brewery = { mode: 'ambiguous' };
      }

      let style: StyleLookup = { mode: 'none' };
      if (candidate.style && String(candidate.style).trim()) {
        const matches = stylesByNormalized.get(normalizeText(candidate.style)) || [];
        if (reviewIntent?.intent.mode !== 'image_only' && matches.length === 1 && matches[0].archived_at) {
          blockers.push({ candidate_id: staged.id, candidate_key: staged.candidate_key, reasons: ['style_archived'] });
          continue;
        }
        if (matches.length === 1) {
          style = { mode: 'existing', style_id: matches[0].id, category_id: matches[0].cat_id ?? null };
        } else {
          style = { mode: 'unresolved', style: candidate.style };
        }
      }

      const imageDecision = candidate.image_decision_fetch_id
        ? imageDecisionByFetch.get(candidate.image_decision_fetch_id) ?? null
        : null;

      const result = evaluateEligibility({
        candidate,
        reviewIntent,
        selectionDecisionId,
        unresolvedPairs: pairsByCandidate.get(candidate.id) || 0,
        imageDecision: imageDecision
          ? {
              id: imageDecision.id,
              fetch_id: imageDecision.fetch_id,
              image_ref: imageDecision.image_ref,
              image_sha256: imageDecision.image_sha256,
            }
          : null,
        brewery,
        style,
      });
      if (result.ok) records.push({ ...result.record, payload_sha256: reviewPayloadSha256(staged.payload) });
      else blockers.push({ candidate_id: result.candidate_id, candidate_key: result.candidate_key, reasons: result.reasons });
    }

    if (blockers.length > 0) {
      const detail = blockers
        .map((b) => `candidate ${b.candidate_id} (${b.candidate_key}): ${b.reasons.join(', ')}`)
        .join('; ');
      res.status(422).json({
        error: {
          code: 'unprocessable_entity',
          message: `Manifest build refused: ${blockers.length} selected candidate(s) are not import-eligible. ${detail}`,
        },
        blockers,
      });
      return;
    }

    const { adminUserId, adminUid } = actorOf(res);
    const now = new Date();
    const existing = await readPrisma.discovery_import_manifests.findMany({
      where: { batch_id: batchId },
      select: { id: true },
    });
    const todayPrefix = `mf-${batch.slug}-${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}-`;
    let seq = 1;
    for (const m of existing) {
      if (typeof m.id === 'string' && m.id.startsWith(todayPrefix)) {
        const n = Number(m.id.slice(todayPrefix.length));
        if (Number.isInteger(n) && n >= seq) seq = n + 1;
      }
    }
    const id = manifestIdFor(batch.slug, now, seq);
    const content = buildManifestContent({
      schema: REVIEW_MANIFEST_SCHEMA,
      id,
      batch: { id: batch.id, slug: batch.slug, bundle_sha256: batch.bundle_sha256 },
      fingerprint,
      createdAt: now,
      createdBy: adminUserId,
      records,
    });
    const sha256 = manifestSha256(content);

    let row: any;
    try {
      await writePrisma.$transaction(async (tx: any) => {
        row = await tx.discovery_import_manifests.create({
          data: {
            id,
            batch_id: batchId,
            manifest: content,
            sha256,
            record_count: records.length,
            catalog_fingerprint: fingerprint,
            status: 'draft',
            built_by: adminUserId,
            built_by_uid: adminUid,
          },
        });
        await tx.discovery_manifest_events.create({
          data: {
            manifest_id: id,
            action: 'build',
            from_status: null,
            to_status: 'draft',
            note: null,
            actor_id: adminUserId,
            actor_uid: adminUid,
          },
        });
      });
    } catch (e: any) {
      if (e && e.code === 'P2002') {
        throw conflict('A manifest with this id or content hash already exists; rebuild to create a new manifest.');
      }
      throw e;
    }

    const full = await requireManifest(id);
    res.status(201).json(serializeManifestRow(full, canApprove(res)));
  }));

  router.get('/discovery/manifests', wrap(async (req: Request, res: Response) => {
    const pagination = parsePagination(req.query as any);
    const where: any = {};
    const batchIdRaw = (req.query as any).batch_id;
    if (batchIdRaw !== undefined) where.batch_id = parseIdParam(String(batchIdRaw));
    const [total, rows] = await Promise.all([
      readPrisma.discovery_import_manifests.count({ where }),
      readPrisma.discovery_import_manifests.findMany({
        where,
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        skip: skipFor(pagination),
        take: pagination.pageSize,
        include: {
          batch: { select: { id: true, slug: true } },
          builder: { select: { id: true, user_name: true } },
          approver: { select: { id: true, user_name: true } },
        },
      }),
    ]);
    res.json({
      results: rows.map((m: any) => serializeManifestRow(m, canApprove(res))),
      pagination: paginationResult(pagination.page, pagination.pageSize, total),
    });
  }));

  router.get('/discovery/manifests/:id', wrap(async (req: Request, res: Response) => {
    const row = await requireManifest(req.params.id);
    const events = await readPrisma.discovery_manifest_events.findMany({
      where: { manifest_id: row.id },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: 50,
      include: { actor: { select: { id: true, user_name: true } } },
    });
    const content = row.manifest as any;
    res.json({
      ...serializeManifestRow(row, canApprove(res)),
      bundle_sha256: row.batch && content?.batch ? content.batch.bundle_sha256 : null,
      catalog_fingerprint: row.catalog_fingerprint,
      records: Array.isArray(content?.records)
        ? content.records.map((r: any) => ({
            ...(r.kind ? { kind: r.kind } : {}),
            ...(r.target_beer_id != null ? { target_beer_id: r.target_beer_id } : {}),
            candidate_id: r.candidate_id,
            candidate_key: r.candidate_key,
            payload_sha256: r.payload_sha256,
            selection_decision_id: r.selection_decision_id,
            beer_name: r.beer?.name ?? null,
            brewery_name: r.beer?.brewery_name ?? null,
            brewery: r.brewery ?? null,
            style: r.style ?? null,
            image: r.image
              ? { decision_id: r.image.decision_id, fetch_id: r.image.fetch_id, ref: r.image.ref, sha256: r.image.sha256 }
              : null,
          }))
        : [],
      events: events.map(serializeManifestEvent),
    });
  }));

  router.get('/discovery/manifests/:id/export', wrap(async (req: Request, res: Response) => {
    const row = await readPrisma.discovery_import_manifests.findUnique({
      where: { id: req.params.id },
      select: { id: true, manifest: true, sha256: true },
    });
    if (!row) throw notFound('Discovery import manifest not found.');
    const bytes = canonicalManifestBytes(row.manifest);
    res.status(200);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${row.id}.json"`);
    res.setHeader('X-Manifest-Sha256', row.sha256);
    res.send(bytes);
  }));

  router.post('/discovery/manifests/:id/approve', wrap(async (req: Request, res: Response) => {
    if (!writePrisma) {
      throw serviceUnavailable(
        'Discovery manifest approval is not configured on this server (DATABASE_URL_DISCOVERY_WRITE is unset).',
      );
    }
    const row = await requireManifest(req.params.id);
    if (!canApprove(res)) {
      throw forbidden(
        'Manifest approval is restricted to the allowlisted approver account (DISCOVERY_MANIFEST_APPROVER_USER_IDS).',
      );
    }
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const supplied = body.sha256;
    if (typeof supplied !== 'string' || !/^[0-9a-f]{64}$/.test(supplied)) {
      throw invalidParameter('sha256 must be the 64-character lowercase hex SHA-256 of the manifest being approved.');
    }
    if (supplied !== row.sha256) {
      throw unprocessable(
        'The supplied sha256 does not match the stored manifest hash. Approval refused; verify the manifest export and its hash before approving.',
      );
    }
    if (row.status !== 'draft') {
      throw conflict(`Manifest ${row.id} is ${row.status}; only a draft manifest can be approved.`);
    }
    const { adminUserId, adminUid } = actorOf(res);
    const now = new Date();
    await writePrisma.$transaction(async (tx: any) => {
      const updated = await tx.discovery_import_manifests.updateMany({
        where: { id: row.id, status: 'draft' },
        data: {
          status: 'approved',
          approved_by: adminUserId,
          approved_at: now,
          approved_sha256: supplied,
        },
      });
      if (!updated || updated.count !== 1) {
        throw conflict(`Manifest ${row.id} was already decided by someone else.`);
      }
      await tx.discovery_manifest_events.create({
        data: {
          manifest_id: row.id,
          action: 'approve',
          from_status: 'draft',
          to_status: 'approved',
          note: null,
          actor_id: adminUserId,
          actor_uid: adminUid,
        },
      });
    });
    const full = await requireManifest(row.id);
    res.json(serializeManifestRow(full, canApprove(res)));
  }));

  router.post('/discovery/manifests/:id/void', wrap(async (req: Request, res: Response) => {
    if (!writePrisma) {
      throw serviceUnavailable(
        'Discovery manifest voiding is not configured on this server (DATABASE_URL_DISCOVERY_WRITE is unset).',
      );
    }
    const row = await requireManifest(req.params.id);
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const noteRaw = body.note;
    const note = typeof noteRaw === 'string' && noteRaw.trim()
      ? noteRaw.trim().slice(0, MAX_NOTE_LENGTH)
      : null;
    if (row.status !== 'draft' && row.status !== 'approved') {
      throw conflict(`Manifest ${row.id} is ${row.status}; only a draft or approved manifest can be voided.`);
    }
    const { adminUserId, adminUid } = actorOf(res);
    await writePrisma.$transaction(async (tx: any) => {
      const updated = await tx.discovery_import_manifests.updateMany({
        where: { id: row.id, status: row.status },
        data: { status: 'void' },
      });
      if (!updated || updated.count !== 1) {
        throw conflict(`Manifest ${row.id} changed while it was being voided.`);
      }
      await tx.discovery_manifest_events.create({
        data: {
          manifest_id: row.id,
          action: 'void',
          from_status: row.status,
          to_status: 'void',
          note,
          actor_id: adminUserId,
          actor_uid: adminUid,
        },
      });
    });
    const full = await requireManifest(row.id);
    res.json(serializeManifestRow(full, canApprove(res)));
  }));

  return router;
};
