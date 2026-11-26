import { Router, Request, Response } from 'express';
import { conflict, forbidden, invalidParameter, notFound, sendError, serviceUnavailable } from '../errors';
import { parseIdParam, parsePagination, paginationResult, skipFor } from '../pagination';
import { CatalogAction, CatalogEntity, CATALOG_FIELDS, applyCatalogChange, fingerprint, isRoutine, lockCatalog, lockEntity, parseChanges, parseEntity, snapshot } from '../catalogChanges';

const wrap = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response) => { fn(req, res).catch((e) => {
    if (e?.code === 'P2002') return sendError(res, conflict('A catalog record with these unique values already exists.'));
    if (e?.code === 'P2003') return sendError(res, conflict('A referenced catalog record no longer exists. Reload and review the change.'));
    return sendError(res, e);
  }); };
const validHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function createCatalogChangesRouter(read: any, write: any) {
  const router = Router();
  const writable = () => { if (!write) throw serviceUnavailable('Catalog changes are not configured.'); return write; };
  const owner = (res: Response) => { if (res.locals.adminRole !== 'owner') throw forbidden('Owner access required.'); };

  router.get('/catalog/change-options/:entity/:id', wrap(async (req, res) => {
    const entity = parseEntity(req.params.entity);
    const id = parseIdParam(req.params.id);
    const row = await read[entity].findUnique({ where: { id } });
    if (!row) throw notFound('Catalog entry not found.');
    res.json({ entity, id, fields: CATALOG_FIELDS[entity], current: snapshot(row), version: fingerprint(row), writes_enabled: Boolean(write), archive_enabled: process.env.CATALOG_ARCHIVE_ENABLED === 'true' });
  }));

  router.get('/catalog/changes', wrap(async (req, res) => {
    const pagination = parsePagination(req.query as any);
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    if (status && !['pending', 'applied', 'rejected', 'reverted'].includes(status)) throw invalidParameter('Unknown status.');
    const where = status ? { status } : {};
    const [total, rows] = await Promise.all([
      read.catalog_change_requests.count({ where }),
      read.catalog_change_requests.findMany({ where, orderBy: { id: 'desc' }, skip: skipFor(pagination), take: pagination.pageSize }),
    ]);
    const uids = [...new Set(rows.flatMap((row: any) => [row.requested_by_uid, row.reviewed_by_uid].filter(Boolean)))];
    const users = uids.length ? await read.users.findMany({ where: { uid: { in: uids } }, select: { uid: true, user_name: true } }) : [];
    const names = new Map(users.map((user: any) => [user.uid, user.user_name]));
    res.json({ results: rows.map((row: any) => ({ ...row, requested_by_name: names.get(row.requested_by_uid) || null, reviewed_by_name: names.get(row.reviewed_by_uid) || null })), pagination: paginationResult(pagination.page, pagination.pageSize, total), can_approve: res.locals.adminRole === 'owner', writes_enabled: Boolean(write) });
  }));

  router.get('/catalog/changes/:id', wrap(async (req, res) => {
    const id = parseIdParam(req.params.id);
    const row = await read.catalog_change_requests.findUnique({ where: { id }, include: { events: { orderBy: { id: 'asc' } } } });
    if (!row) throw notFound('Change request not found.');
    res.json({ ...row, can_approve: res.locals.adminRole === 'owner', writes_enabled: Boolean(write) });
  }));

  router.post('/catalog/change-options/:entity/:id/requests', wrap(async (req, res) => {
    const db = writable();
    const entity = parseEntity(req.params.entity);
    const id = parseIdParam(req.params.id);
    const action: CatalogAction = req.body?.action;
    if (!['edit', 'archive'].includes(action)) throw invalidParameter('Action must be edit or archive.');
    if (action === 'archive' && process.env.CATALOG_ARCHIVE_ENABLED !== 'true') throw serviceUnavailable('Archiving is disabled until all catalog consumers honor archived entries.');
    if (!validHash(req.body?.version)) throw invalidParameter('A current version is required.');
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason || reason.length > 1000) throw invalidParameter('A reason of up to 1000 characters is required.');
    const changes = action === 'edit' ? parseChanges(entity, req.body?.changes) : {};
    const automatic = isRoutine(entity, action, changes);
    const created = await db.$transaction(async (tx: any) => {
      await lockCatalog(tx);
      const before = await lockEntity(tx, entity, id);
      if (fingerprint(before) !== req.body.version) throw conflict('This entry changed. Reload it before saving.');
      if (before.archived_at) throw conflict('This entry is archived; restore it before editing.');
      const row = await tx.catalog_change_requests.create({ data: {
        entity_type: entity, entity_id: id, action, status: 'pending', before_data: before,
        proposed_data: changes, before_hash: fingerprint(before), requested_by_uid: res.locals.firebaseUid, reason,
      } });
      await tx.catalog_change_events.create({ data: { request_id: row.id, actor_uid: res.locals.firebaseUid, action: 'requested' } });
      if (!automatic) return row;
      const after = await applyCatalogChange(tx, entity, id, action, changes);
      const updated = await tx.catalog_change_requests.update({ where: { id: row.id }, data: { status: 'applied', after_hash: fingerprint(after), decided_at: new Date() } });
      await tx.catalog_change_events.create({ data: { request_id: row.id, actor_uid: res.locals.firebaseUid, action: 'applied' } });
      return updated;
    });
    res.status(201).json(created);
  }));

  router.post('/catalog/changes/:id/:decision', wrap(async (req, res) => {
    owner(res);
    const db = writable();
    const id = parseIdParam(req.params.id);
    const decision = req.params.decision;
    if (!['approve', 'reject', 'revert'].includes(decision)) throw notFound('Action not found.');
    const result = await db.$transaction(async (tx: any) => {
      await lockCatalog(tx);
      await tx.$queryRaw`SELECT id FROM catalog_change_requests WHERE id = ${id} FOR UPDATE`;
      const row = await tx.catalog_change_requests.findUnique({ where: { id } });
      if (!row) throw notFound('Change request not found.');
      if (decision === 'reject') {
        if (row.status !== 'pending') throw conflict('Only pending changes can be rejected.');
        const updated = await tx.catalog_change_requests.update({ where: { id }, data: { status: 'rejected', reviewed_by_uid: res.locals.firebaseUid, decided_at: new Date() } });
        await tx.catalog_change_events.create({ data: { request_id: id, actor_uid: res.locals.firebaseUid, action: 'rejected' } });
        return updated;
      }
      if (decision === 'approve' && row.status !== 'pending') throw conflict('Only pending changes can be approved.');
      if (decision === 'revert' && row.status !== 'applied') throw conflict('Only applied changes can be reverted.');
      const entity: CatalogEntity = parseEntity(row.entity_type);
      const current = await lockEntity(tx, entity, row.entity_id);
      const expected = decision === 'approve' ? row.before_hash : row.after_hash;
      if (!validHash(expected) || fingerprint(current) !== expected) throw conflict('The catalog entry changed since this request. Review the current entry before continuing.');
      let after: any;
      if (decision === 'approve') {
        const action: CatalogAction = row.action;
        if (action === 'archive' && process.env.CATALOG_ARCHIVE_ENABLED !== 'true') throw serviceUnavailable('Archiving is disabled until all catalog consumers honor archived entries.');
        const changes = action === 'edit' ? parseChanges(entity, row.proposed_data) : {};
        if (!['edit', 'archive'].includes(action)) throw conflict('Unsupported request action.');
        if (current.archived_at) throw conflict('The entry is already archived.');
        after = await applyCatalogChange(tx, entity, row.entity_id, action, changes);
      } else {
        const before = row.before_data as Record<string, unknown>;
        const restore: Record<string, unknown> = {};
        if (row.action === 'archive') restore.archived_at = before.archived_at;
        else for (const key of Object.keys(row.proposed_data)) restore[key] = before[key];
        after = await applyCatalogChange(tx, entity, row.entity_id, 'edit', restore);
      }
      const status = decision === 'approve' ? 'applied' : 'reverted';
      const updated = await tx.catalog_change_requests.update({ where: { id }, data: { status, after_hash: fingerprint(after), reviewed_by_uid: res.locals.firebaseUid, decided_at: new Date() } });
      await tx.catalog_change_events.create({ data: { request_id: id, actor_uid: res.locals.firebaseUid, action: status } });
      return updated;
    });
    res.json(result);
  }));

  return router;
}
