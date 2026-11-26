// Catalog routes. All GET, all read only, all mounted behind
// decodeAdminToken by app.ts. Every list runs a count plus a paged query.
import { Router, Request, Response } from 'express';
import { sendError, notFound, invalidParameter } from '../errors';
import {
  parsePagination, parseSort, orderByFor, parseIdParam, parseFilterId,
  parseBooleanFilter, paginationResult, skipFor,
} from '../pagination';
import * as P from '../projections';
import { unknownNumber, emptyToNull, breweryRef, styleRef, categoryRef, beerRef, collectionRef } from '../serialize';
import { resolveImages, resolveImage } from '../images';

const wrap = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response) => { fn(req, res).catch((e) => sendError(res, e)); };

export const serializeBeerListRow = (beer: any, image: any) => ({
  id: beer.id,
  name: beer.name,
  brewery: breweryRef(beer.brewery),
  style: styleRef(beer.style),
  category: categoryRef(beer.category),
  brewery_id: beer.brewery_id ?? null,
  style_id: beer.style_id ?? null,
  cat_id: beer.cat_id ?? null,
  abv: unknownNumber(beer.abv),
  ibu: unknownNumber(beer.ibu),
  srm: unknownNumber(beer.srm),
  discontinued: beer.discontinued,
  last_mod: beer.last_mod,
  image_url: image ? image.image_url : null,
  image_kind: image ? image.image_kind : 'initials',
  image_provenance: image ? image.image_provenance : null,
});

export const createCatalogRouter = (prisma: any) => {
  const router = Router();

  router.get('/catalog/beers', wrap(async (req, res) => {
    const pagination = parsePagination(req.query as any);
    const sort = parseSort(req.query as any, ['name', 'abv', 'ibu', 'last_mod', 'id']);
    const breweryId = parseFilterId((req.query as any).brewery_id, 'brewery_id');
    const styleId = parseFilterId((req.query as any).style_id, 'style_id');
    const categoryId = parseFilterId((req.query as any).category_id, 'category_id');
    const discontinued = parseBooleanFilter((req.query as any).discontinued, 'discontinued');
    if (breweryId !== null) {
      const row = await prisma.breweries.findUnique({ where: { id: breweryId }, select: { id: true } });
      if (!row) throw invalidParameter('brewery_id ' + breweryId + ' does not exist.');
    }
    if (styleId !== null) {
      const row = await prisma.styles.findUnique({ where: { id: styleId }, select: { id: true } });
      if (!row) throw invalidParameter('style_id ' + styleId + ' does not exist.');
    }
    if (categoryId !== null) {
      const row = await prisma.categories.findUnique({ where: { id: categoryId }, select: { id: true } });
      if (!row) throw invalidParameter('category_id ' + categoryId + ' does not exist.');
    }
    const where: any = { archived_at: null };
    const q = (req.query as any).q;
    if (q) where.name = { contains: String(q), mode: 'insensitive' };
    if (breweryId !== null) where.brewery_id = breweryId;
    if (styleId !== null) where.style_id = styleId;
    if (categoryId !== null) where.cat_id = categoryId;
    if (discontinued !== null) where.discontinued = discontinued;
    const [total, rows] = await Promise.all([
      prisma.beers.count({ where }),
      prisma.beers.findMany({ where, select: P.beerListSelect, orderBy: orderByFor(sort), skip: skipFor(pagination), take: pagination.pageSize }),
    ]);
    const images = await resolveImages(prisma, rows);
    const results = rows.map((b: any) => serializeBeerListRow(b, images.get(b.id)));
    res.json({ results, pagination: paginationResult(pagination.page, pagination.pageSize, total) });
  }));

  router.get('/catalog/beers/:id', wrap(async (req, res) => {
    const id = parseIdParam(req.params.id);
    const beer = await prisma.beers.findUnique({ where: { id }, select: P.beerDetailSelect });
    if (!beer) throw notFound('Beer not found.');
    const image = await resolveImage(prisma, beer);
    const [triedCount, likedCount, memberships] = await Promise.all([
      res.locals.adminRole === 'owner' ? prisma.user_beers.count({ where: { beer_id: id } }) : null,
      res.locals.adminRole === 'owner' ? prisma.user_beers.count({ where: { beer_id: id, liked: true } }) : null,
      // Capped so a detail response stays bounded no matter how many
      // collections a beer joins (QA finding: unbounded findMany).
      prisma.collection_beers.findMany({ where: { beer_id: id }, select: P.collectionBeerListSelect, orderBy: { id: 'asc' }, take: 200 }),
    ]);
    res.json({
      id: beer.id,
      name: beer.name,
      brewery: breweryRef(beer.brewery),
      style: styleRef(beer.style),
      category: categoryRef(beer.category),
      brewery_id: beer.brewery_id ?? null,
      style_id: beer.style_id ?? null,
      cat_id: beer.cat_id ?? null,
      abv: unknownNumber(beer.abv),
      ibu: unknownNumber(beer.ibu),
      srm: unknownNumber(beer.srm),
      upc: emptyToNull(beer.upc),
      descript: emptyToNull(beer.descript),
      discontinued: beer.discontinued,
      last_mod: beer.last_mod,
      image_url: image.image_url,
      image_kind: image.image_kind,
      image_provenance: image.image_provenance,
      collections: (memberships || []).map((m: any) => collectionRef(m.collections)).filter(Boolean),
      user_beers_count: triedCount,
      liked_count: likedCount,
      counts: { user_beers: triedCount, liked_user_beers: likedCount },
    });
  }));

  router.get('/catalog/breweries', wrap(async (req, res) => {
    const pagination = parsePagination(req.query as any);
    const sort = parseSort(req.query as any, ['name', 'city', 'last_mod', 'id']);
    const where: any = { archived_at: null };
    const q = (req.query as any).q;
    if (q) where.name = { contains: String(q), mode: 'insensitive' };
    if ((req.query as any).country) where.country = { contains: String((req.query as any).country), mode: 'insensitive' };
    if ((req.query as any).state) where.state = { contains: String((req.query as any).state), mode: 'insensitive' };
    const [total, rows] = await Promise.all([
      prisma.breweries.count({ where }),
      prisma.breweries.findMany({ where, select: P.breweryListSelect, orderBy: orderByFor(sort), skip: skipFor(pagination), take: pagination.pageSize }),
    ]);
    const results = rows.map((r: any) => ({
      id: r.id, name: r.name, city: r.city, state: r.state, country: r.country, last_mod: r.last_mod,
      beer_count: r._count ? r._count.beers : 0,
      _count: r._count,
    }));
    res.json({ results, pagination: paginationResult(pagination.page, pagination.pageSize, total) });
  }));

  router.get('/catalog/breweries/:id', wrap(async (req, res) => {
    const id = parseIdParam(req.params.id);
    const brewery = await prisma.breweries.findUnique({ where: { id }, select: P.breweryDetailSelect });
    if (!brewery) throw notFound('Brewery not found.');
    const pagination = parsePagination(req.query as any);
    const beerWhere = { brewery_id: id, archived_at: null };
    const [beerCount, beers, geocode] = await Promise.all([
      prisma.beers.count({ where: beerWhere }),
      prisma.beers.findMany({ where: beerWhere, select: P.beerListSelect, orderBy: { id: 'asc' }, skip: skipFor(pagination), take: pagination.pageSize }),
      prisma.breweries_geocode.findFirst({ where: { brewery_id: id }, select: P.breweryGeocodeSelect, orderBy: { id: 'asc' } }),
    ]);
    const images = await resolveImages(prisma, beers);
    res.json({
      ...brewery,
      descript: emptyToNull(brewery.descript),
      beer_count: beerCount,
      geocode: geocode || null,
      beers: beers.map((b: any) => serializeBeerListRow(b, images.get(b.id))),
      beers_pagination: paginationResult(pagination.page, pagination.pageSize, beerCount),
      pagination: paginationResult(pagination.page, pagination.pageSize, beerCount),
    });
  }));

  router.get('/catalog/categories', wrap(async (req, res) => {
    const pagination = parsePagination(req.query as any);
    const sort = parseSort(req.query as any, ['cat_name', 'last_mod', 'id']);
    const where: any = { archived_at: null };
    const q = (req.query as any).q;
    if (q) where.cat_name = { contains: String(q), mode: 'insensitive' };
    const [total, rows] = await Promise.all([
      prisma.categories.count({ where }),
      prisma.categories.findMany({ where, select: P.categoryListSelect, orderBy: orderByFor(sort), skip: skipFor(pagination), take: pagination.pageSize }),
    ]);
    const results = rows.map((r: any) => ({
      id: r.id, cat_name: r.cat_name, name: r.cat_name, last_mod: r.last_mod,
      beer_count: r._count ? r._count.beers : 0,
      style_count: r._count ? r._count.styles : 0,
      _count: r._count,
    }));
    res.json({ results, pagination: paginationResult(pagination.page, pagination.pageSize, total) });
  }));

  router.get('/catalog/categories/:id', wrap(async (req, res) => {
    const id = parseIdParam(req.params.id);
    const category = await prisma.categories.findUnique({ where: { id }, select: P.categoryDetailSelect });
    if (!category) throw notFound('Category not found.');
    const [styles, beerCount] = await Promise.all([
      // Capped for the same reason as the beer memberships query above;
      // the whole styles table is 147 rows today, so 500 never truncates
      // in practice while keeping the query bounded (QA finding).
      prisma.styles.findMany({ where: { cat_id: id, archived_at: null }, select: P.styleDetailSelect, orderBy: { id: 'asc' }, take: 500 }),
      prisma.beers.count({ where: { cat_id: id, archived_at: null } }),
    ]);
    res.json({
      ...category, name: category.cat_name,
      styles: (styles || []).map((s: any) => ({ id: s.id, style_name: s.style_name, name: s.style_name, cat_id: s.cat_id, last_mod: s.last_mod })),
      beer_count: beerCount,
    });
  }));

  router.get('/catalog/styles', wrap(async (req, res) => {
    const pagination = parsePagination(req.query as any);
    const sort = parseSort(req.query as any, ['style_name', 'last_mod', 'id']);
    const where: any = { archived_at: null };
    const q = (req.query as any).q;
    if (q) where.style_name = { contains: String(q), mode: 'insensitive' };
    const categoryId = parseFilterId((req.query as any).category_id, 'category_id');
    if (categoryId !== null) where.cat_id = categoryId;
    const [total, rows] = await Promise.all([
      prisma.styles.count({ where }),
      prisma.styles.findMany({ where, select: P.styleListSelect, orderBy: orderByFor(sort), skip: skipFor(pagination), take: pagination.pageSize }),
    ]);
    const results = rows.map((r: any) => ({
      id: r.id, style_name: r.style_name, name: r.style_name, cat_id: r.cat_id, last_mod: r.last_mod,
      category: categoryRef(r.category), beer_count: r._count ? r._count.beers : 0, _count: r._count,
    }));
    res.json({ results, pagination: paginationResult(pagination.page, pagination.pageSize, total) });
  }));

  router.get('/catalog/styles/:id', wrap(async (req, res) => {
    const id = parseIdParam(req.params.id);
    const style = await prisma.styles.findUnique({ where: { id }, select: P.styleDetailSelect });
    if (!style) throw notFound('Style not found.');
    const beerCount = await prisma.beers.count({ where: { style_id: id, archived_at: null } });
    res.json({
      ...style, name: style.style_name, category: categoryRef(style.category), beer_count: beerCount,
    });
  }));

  router.get('/catalog/collections', wrap(async (req, res) => {
    const pagination = parsePagination(req.query as any);
    const sort = parseSort(req.query as any, ['name', 'difficulty', 'created_at', 'id']);
    const where: any = {};
    const q = (req.query as any).q;
    if (q) where.name = { contains: String(q), mode: 'insensitive' };
    const [total, rows] = await Promise.all([
      prisma.collections.count({ where }),
      prisma.collections.findMany({ where, select: res.locals.adminRole === 'owner' ? P.collectionListSelect : { ...P.collectionListSelect, _count: { select: { collection_beers: true } } }, orderBy: orderByFor(sort), skip: skipFor(pagination), take: pagination.pageSize }),
    ]);
    const results = rows.map((r: any) => ({
      ...r,
      _count: r._count ? { collection_beers: r._count.collection_beers, ...(res.locals.adminRole === 'owner' ? { user_badges: r._count.user_badges } : {}) } : null,
      beer_count: r._count ? r._count.collection_beers : 0,
      member_count: r._count ? r._count.collection_beers : 0,
      badge_holder_count: res.locals.adminRole === 'owner' ? (r._count ? r._count.user_badges : 0) : null,
    }));
    res.json({ results, pagination: paginationResult(pagination.page, pagination.pageSize, total) });
  }));

  router.get('/catalog/collections/:id', wrap(async (req, res) => {
    const id = parseIdParam(req.params.id);
    const collection = await prisma.collections.findUnique({ where: { id }, select: P.collectionDetailSelect });
    if (!collection) throw notFound('Collection not found.');
    const pagination = parsePagination(req.query as any);
    const where = { collection_id: id };
    const [total, members, badgeCount] = await Promise.all([
      prisma.collection_beers.count({ where }),
      prisma.collection_beers.findMany({ where, select: P.collectionBeerListSelect, orderBy: { id: 'asc' }, skip: skipFor(pagination), take: pagination.pageSize }),
      res.locals.adminRole === 'owner' ? prisma.user_badges.count({ where: { collection_id: id } }) : null,
    ]);
    res.json({
      ...collection,
      badge_holder_count: badgeCount,
      beers: (members || []).map((m: any) => ({ id: m.id, beer: beerRef(m.beers), collection: collectionRef(m.collections), created_at: m.created_at })),
      members: (members || []).map((m: any) => ({ id: m.id, beer: beerRef(m.beers), created_at: m.created_at })),
      pagination: paginationResult(pagination.page, pagination.pageSize, total),
    });
  }));

  router.get('/catalog/collection-beers', wrap(async (req, res) => {
    const pagination = parsePagination(req.query as any);
    const sort = parseSort(req.query as any, ['id', 'created_at']);
    const collectionId = parseFilterId((req.query as any).collection_id, 'collection_id');
    const beerId = parseFilterId((req.query as any).beer_id, 'beer_id');
    const where: any = {};
    if (collectionId !== null) where.collection_id = collectionId;
    if (beerId !== null) where.beer_id = beerId;
    const [total, rows] = await Promise.all([
      prisma.collection_beers.count({ where }),
      prisma.collection_beers.findMany({ where, select: P.collectionBeerListSelect, orderBy: orderByFor(sort), skip: skipFor(pagination), take: pagination.pageSize }),
    ]);
    const results = rows.map((r: any) => ({
      id: r.id, collection_id: r.collection_id, beer_id: r.beer_id, created_at: r.created_at, updated_at: r.updated_at,
      collection: collectionRef(r.collections), beer: beerRef(r.beers),
    }));
    res.json({ results, pagination: paginationResult(pagination.page, pagination.pageSize, total) });
  }));

  router.get('/catalog/beverage-images', wrap(async (req, res) => {
    const pagination = parsePagination(req.query as any);
    const sort = parseSort(req.query as any, ['id', 'created_at']);
    const beverageId = parseFilterId((req.query as any).beverage_id, 'beverage_id');
    const where: any = {};
    if (beverageId !== null) where.beverage_id = beverageId;
    if ((req.query as any).status) where.status = String((req.query as any).status);
    const [total, rows] = await Promise.all([
      prisma.beverage_images.count({ where }),
      prisma.beverage_images.findMany({ where, select: P.beverageImageListSelect, orderBy: orderByFor(sort), skip: skipFor(pagination), take: pagination.pageSize }),
    ]);
    res.json({ results: rows, pagination: paginationResult(pagination.page, pagination.pageSize, total) });
  }));

  return router;
};
