// User data routes. All GET, all read only, mounted behind decodeAdminToken.
// The list projection never includes uid or the notification token; the
// detail projection includes uid and email only (plan section 7).
import { Router, Request, Response } from 'express';
import { sendError, notFound } from '../errors';
import {
  parsePagination, parseSort, orderByFor, parseIdParam, parseBooleanFilter,
  paginationResult, skipFor,
} from '../pagination';
import * as P from '../projections';
import { beerRef, collectionRef } from '../serialize';

const wrap = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response) => { fn(req, res).catch((e) => sendError(res, e)); };

export const createUsersRouter = (prisma: any) => {
  const router = Router();

  const requireUser = async (id: number) => {
    const user = await prisma.users.findUnique({ where: { id }, select: { id: true } });
    if (!user) throw notFound('User not found.');
    return user;
  };

  router.get('/users', wrap(async (req, res) => {
    const pagination = parsePagination(req.query as any);
    const sort = parseSort(req.query as any, ['created_at', 'id', 'user_name']);
    const where: any = {};
    const q = (req.query as any).q;
    if (q) {
      where.OR = [
        { user_name: { contains: String(q), mode: 'insensitive' } },
        { email: { contains: String(q), mode: 'insensitive' } },
      ];
    }
    const priv = parseBooleanFilter((req.query as any).private, 'private');
    if (priv !== null) where.private = priv;
    const [total, rows] = await Promise.all([
      prisma.users.count({ where }),
      prisma.users.findMany({ where, select: P.userListSelect, orderBy: orderByFor(sort), skip: skipFor(pagination), take: pagination.pageSize }),
    ]);
    const results = rows.map((r: any) => ({
      id: r.id, user_name: r.user_name, email: r.email, age: r.age, private: r.private,
      created_at: r.created_at, updated_at: r.updated_at,
      tried_count: r._count ? r._count.user_beers : 0,
      badge_count: r._count ? r._count.user_badges : 0,
      _count: r._count,
    }));
    res.json({ results, pagination: paginationResult(pagination.page, pagination.pageSize, total) });
  }));

  router.get('/users/:id', wrap(async (req, res) => {
    const id = parseIdParam(req.params.id);
    const user = await prisma.users.findUnique({ where: { id }, select: P.userDetailSelect });
    if (!user) throw notFound('User not found.');
    res.json({
      id: user.id, uid: user.uid, email: user.email, user_name: user.user_name, age: user.age,
      private: user.private, created_at: user.created_at, updated_at: user.updated_at,
      tried_count: user._count ? user._count.user_beers : 0,
      badge_count: user._count ? user._count.user_badges : 0,
      notification_count: user._count ? user._count.notifications : 0,
      counts: {
        user_beers: user._count ? user._count.user_beers : 0,
        user_badges: user._count ? user._count.user_badges : 0,
        notifications: user._count ? user._count.notifications : 0,
      },
      _count: user._count,
    });
  }));

  router.get('/users/:id/beers', wrap(async (req, res) => {
    const id = parseIdParam(req.params.id);
    await requireUser(id);
    const pagination = parsePagination(req.query as any);
    const sort = parseSort(req.query as any, ['id', 'created_at']);
    const where = { user_id: id };
    const [total, rows] = await Promise.all([
      prisma.user_beers.count({ where }),
      prisma.user_beers.findMany({ where, select: P.userBeerListSelect, orderBy: orderByFor(sort), skip: skipFor(pagination), take: pagination.pageSize }),
    ]);
    const results = rows.map((r: any) => ({
      id: r.id, user_id: r.user_id, beer_id: r.beer_id, liked: r.liked,
      created_at: r.created_at, updated_at: r.updated_at, beer: beerRef(r.beers),
    }));
    res.json({ results, pagination: paginationResult(pagination.page, pagination.pageSize, total) });
  }));

  router.get('/users/:id/badges', wrap(async (req, res) => {
    const id = parseIdParam(req.params.id);
    await requireUser(id);
    const pagination = parsePagination(req.query as any);
    const sort = parseSort(req.query as any, ['id', 'created_at']);
    const where = { user_id: id };
    const [total, rows] = await Promise.all([
      prisma.user_badges.count({ where }),
      prisma.user_badges.findMany({ where, select: P.userBadgeListSelect, orderBy: orderByFor(sort), skip: skipFor(pagination), take: pagination.pageSize }),
    ]);
    const results = rows.map((r: any) => ({
      id: r.id, user_id: r.user_id, collection_id: r.collection_id, earned: r.earned, progress: r.progress,
      created_at: r.created_at, updated_at: r.updated_at, collection: collectionRef(r.collections),
    }));
    res.json({ results, pagination: paginationResult(pagination.page, pagination.pageSize, total) });
  }));

  router.get('/users/:id/friends', wrap(async (req, res) => {
    const id = parseIdParam(req.params.id);
    await requireUser(id);
    const pagination = parsePagination(req.query as any);
    const where: any = { OR: [{ user_1: id }, { user_2: id }] };
    const [total, rows] = await Promise.all([
      prisma.friends.count({ where }),
      prisma.friends.findMany({ where, select: P.friendListSelect, orderBy: { id: 'asc' }, skip: skipFor(pagination), take: pagination.pageSize }),
    ]);
    const results = rows.map((r: any) => {
      const other = r.user_1 === id ? r.users_friends_user_2Tousers : r.users_friends_user_1Tousers;
      return {
        id: r.id, user_1: r.user_1, user_2: r.user_2, created_at: r.created_at, updated_at: r.updated_at,
        other_user: other ? { id: other.id, user_name: other.user_name } : null,
        friend: other ? { id: other.id, user_name: other.user_name } : null,
      };
    });
    res.json({ results, pagination: paginationResult(pagination.page, pagination.pageSize, total) });
  }));

  router.get('/users/:id/notifications', wrap(async (req, res) => {
    const id = parseIdParam(req.params.id);
    await requireUser(id);
    const pagination = parsePagination(req.query as any);
    const sort = parseSort(req.query as any, ['id', 'created_at']);
    const where = { user_id: id };
    const [total, rows] = await Promise.all([
      prisma.notifications.count({ where }),
      prisma.notifications.findMany({ where, select: P.notificationListSelect, orderBy: orderByFor(sort), skip: skipFor(pagination), take: pagination.pageSize }),
    ]);
    const results = rows.map((r: any) => ({
      id: r.id, user_id: r.user_id, type: r.type, message: r.message, viewed: r.viewed,
      created_at: r.created_at, updated_at: r.updated_at,
    }));
    res.json({ results, pagination: paginationResult(pagination.page, pagination.pageSize, total) });
  }));

  return router;
};
