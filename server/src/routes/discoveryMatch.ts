// Discovery match suggestions (guided review): a READ-ONLY,
// advisory endpoint that preloads ranked likely catalog matches for
// a staged candidate so the reviewer does not start from a blank
// search.
//
//   GET /admin-api/v1/discovery/candidates/:id/match-suggestions
//     200 { candidate_id, suggestions: [{ beer_id, name,
//           brewery_name, abv, barcode, score, evidence }],
//           exhaustive, scanned }
//     404 when the candidate does not exist.
//     503 when no read client is configured.
//
// Suggestions are ranked by the pure scoring in
// ../discoveryMatchCore with machine-readable evidence per
// suggestion. The endpoint records nothing and selects nothing: no
// suggestion is ever marked chosen, and accepting one remains the
// reviewer's explicit, audited review-intent action elsewhere.
// `exhaustive` is false when the bounded similarity scan could not
// consider the whole catalog (see discoveryMatchCore for the
// bounds); the UI must surface that as "not exhaustive".
//
// Auth/role posture matches the other discovery read routes: mounted
// behind decodeAdminToken by app.ts and served by the read-only
// viewer Prisma client.
import { Router, Request, Response } from 'express';
import { sendError, notFound, serviceUnavailable } from '../errors';
import { parseIdParam } from '../pagination';
import { findMatchSuggestions, MatchSuggestionsOptions } from '../discoveryMatchCore';

const wrap = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response) => { fn(req, res).catch((e) => sendError(res, e)); };

export const createDiscoveryMatchRouter = (prisma: any, opts: MatchSuggestionsOptions = {}) => {
  const router = Router();

  router.get('/discovery/candidates/:id/match-suggestions', wrap(async (req, res) => {
    if (!prisma) {
      throw serviceUnavailable('Discovery match suggestions are not configured on this server.');
    }
    const id = parseIdParam(req.params.id);
    const result = await findMatchSuggestions(prisma, id, opts);
    if (!result) throw notFound('Discovery candidate not found.');
    res.json(result);
  }));

  return router;
};
