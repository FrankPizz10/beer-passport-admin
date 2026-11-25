// Match suggestions for discovery candidates (guided review,
// issues/001 follow-up): given a staged candidate, rank existing
// catalog beers that might be the same product, with machine-readable
// evidence for every suggestion. The result is ADVISORY ONLY: this
// module records nothing, selects nothing, and never marks a target
// as chosen. The reviewer always decides.
//
// Two layers:
//   - Pure scoring (normalize/score/rank below): deterministic, no
//     I/O, unit-tested without a database.
//   - findMatchSuggestions: staged, BOUNDED database access through
//     an injected Prisma-like client. Exact lookups first (barcode,
//     exact name), then ONE bounded similarity scan driven by the
//     candidate's distinctive tokens. The scan never loads the whole
//     catalog unboundedly: it asks for at most scanCap + 1 rows and
//     reports exhaustive=false when that bound binds (or when no
//     distinctive token exists to drive the scan), so the UI can say
//     "not exhaustive" instead of implying completeness.
//
// Cost at the current catalog (~5,894 beers): the exact stages are
// equality lookups; the token scan is a handful of LIKE '%token%'
// predicates over beers.name / breweries.name with LIMIT scanCap+1
// (default 500), i.e. at most ~550 rows are ever scored per request.
// At 10x the catalog (~59k beers) the same bounds hold: worst case
// the scan still scores scanCap rows and reports exhaustive=false
// more often; latency grows with the number of token-matching rows
// the database must visit before the LIMIT, not with catalog size
// alone. No new indexes are introduced; if the token scan ever
// becomes a measured bottleneck, a trigram index is the follow-up,
// not a silent schema change here.
//
// Normalization (shared by names and breweries): Unicode NFKD with
// combining marks stripped, lowercased, every run of
// non-alphanumerics collapsed to one space, trimmed. On top of that:
//   - Beer names: ONE trailing generic token "beer" is dropped
//     ("Bud Light Beer" -> "bud light"). Style-bearing words (ale,
//     lager, ipa, stout, ...) are NEVER dropped: "Pale Ale" must not
//     collapse to "pale".
//   - Brewery names: trailing corporate/generic tokens are dropped
//     repeatedly (brewing, brewery, company, co, inc, llc, corp,
//     corporation, ltd), so "Sierra Nevada Brewing" and
//     "Sierra Nevada" compare equal. Nothing else is rewritten: in
//     particular "Budweiser" does NOT become "Anheuser-Busch"; a
//     staged brewery string that differs from the catalog brewery
//     simply earns no brewery_match evidence.

export type MatchEvidence =
  | 'barcode_exact'
  | 'name_exact'
  | 'name_normalized'
  | 'brewery_match'
  | 'name_similar'
  | 'token_overlap';

export type MatchCandidateInput = {
  name: string;
  brewery_name?: string | null;
  barcode?: string | null;
};

export type MatchBeerInput = {
  id: number;
  name: string;
  brewery_name?: string | null;
  abv?: number | null;
  barcode?: string | null;
};

export type MatchSuggestion = {
  beer_id: number;
  name: string;
  brewery_name: string | null;
  abv: number | null;
  barcode: string | null;
  score: number;
  evidence: MatchEvidence[];
};

export const MATCH_SUGGESTION_LIMIT = 10;
export const DEFAULT_MATCH_SCAN_CAP = 500;

const NAME_TRAILING_GENERIC = new Set(['beer']);
const BREWERY_TRAILING_GENERIC = new Set([
  'brewing', 'brewery', 'company', 'co', 'inc', 'llc', 'corp', 'corporation', 'ltd',
]);

export const normalizeText = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');

const dropTrailing = (normalized: string, tokens: Set<string>, repeat: boolean): string => {
  const parts = normalized.split(' ').filter(Boolean);
  while (parts.length > 1 && tokens.has(parts[parts.length - 1])) {
    parts.pop();
    if (!repeat) break;
  }
  return parts.join(' ');
};

export const normalizeBeerName = (name: string): string =>
  dropTrailing(normalizeText(name), NAME_TRAILING_GENERIC, false);

export const normalizeBreweryName = (name: string): string =>
  dropTrailing(normalizeText(name), BREWERY_TRAILING_GENERIC, true);

export const tokenize = (normalized: string): string[] =>
  normalized.split(' ').filter((t) => t.length > 0);

// Distinctive tokens drive the bounded similarity scan: at least 3
// characters (shorter tokens like " bud " fragments match half the
// catalog), longest first so the most specific tokens win the
// predicate budget.
export const distinctiveTokens = (normalized: string, max: number): string[] => {
  const seen = new Set<string>();
  const tokens = tokenize(normalized)
    .filter((t) => t.length >= 3)
    .sort((a, b) => b.length - a.length || a.localeCompare(b));
  for (const t of tokens) {
    if (seen.size >= max) break;
    seen.add(t);
  }
  return [...seen];
};

const levenshtein = (a: string, b: string): number => {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_v, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
};

export const nameSimilarityRatio = (a: string, b: string): number => {
  if (a === b) return 1;
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - levenshtein(a, b) / max;
};

// Character-bigram Dice coefficient. Levenshtein alone is harsh on
// short names ("bud lite" -> "bud light" is 3 edits on 9 chars,
// ratio 0.67, although a human reads them as the same product);
// bigrams capture that overlap (Dice 0.67 there, and 0.56 for the
// genuinely different "coors light" vs "bud light", which stays
// below the similarity gate).
export const bigramDice = (a: string, b: string): number => {
  const grams = (s: string) => {
    const out = new Map<string, number>();
    for (let i = 0; i + 1 < s.length; i++) out.set(s.slice(i, i + 2), (out.get(s.slice(i, i + 2)) || 0) + 1);
    return out;
  };
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const ga = grams(a);
  const gb = grams(b);
  let shared = 0;
  for (const [g, count] of ga) shared += Math.min(count, gb.get(g) || 0);
  const total = (a.length - 1) + (b.length - 1);
  return total === 0 ? 0 : (2 * shared) / total;
};

const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
};

const NAME_SIMILAR_THRESHOLD = 0.8;
const NAME_DICE_THRESHOLD = 0.6;
const TOKEN_OVERLAP_THRESHOLD = 0.5;
const SUGGESTION_FLOOR = 45;

// Score one catalog beer against the candidate. Returns null when
// there is no name-side signal worth suggesting: brewery evidence
// alone never suggests a beer (every product of a large brewery
// would otherwise "match" every staged candidate from it).
export const scoreMatch = (
  candidate: MatchCandidateInput,
  beer: MatchBeerInput,
): { score: number; evidence: MatchEvidence[] } | null => {
  const evidence: MatchEvidence[] = [];

  const candidateBarcode = (candidate.barcode || '').trim();
  const beerBarcode = (beer.barcode || '').trim();
  const barcodeExact = candidateBarcode.length > 0 && candidateBarcode === beerBarcode;
  if (barcodeExact) evidence.push('barcode_exact');

  const nameExact =
    candidate.name.trim().length > 0 &&
    candidate.name.trim().toLowerCase() === beer.name.trim().toLowerCase();
  if (nameExact) evidence.push('name_exact');

  const candidateNorm = normalizeBeerName(candidate.name);
  const beerNorm = normalizeBeerName(beer.name);
  const nameNormalized = candidateNorm.length > 0 && candidateNorm === beerNorm;
  if (nameNormalized && !nameExact) evidence.push('name_normalized');

  const candidateBrewery = normalizeBreweryName(candidate.brewery_name || '');
  const beerBrewery = normalizeBreweryName(beer.brewery_name || '');
  const breweryMatch =
    candidateBrewery.length >= 3 &&
    beerBrewery.length >= 3 &&
    (candidateBrewery === beerBrewery ||
      candidateBrewery.includes(beerBrewery) ||
      beerBrewery.includes(candidateBrewery));
  if (breweryMatch) evidence.push('brewery_match');

  let ratio = 0;
  let nameSimilar = false;
  if (!nameExact && !nameNormalized && candidateNorm.length > 0 && beerNorm.length > 0) {
    // Similarity is the max of the Levenshtein ratio and the
    // bigram Dice coefficient; either may qualify the pair
    // (Levenshtein >= 0.8, Dice >= 0.6, or containment).
    const lev = nameSimilarityRatio(candidateNorm, beerNorm);
    const dice = bigramDice(candidateNorm, beerNorm);
    ratio = Math.max(lev, dice);
    const containment =
      Math.min(candidateNorm.length, beerNorm.length) >= 4 &&
      (candidateNorm.includes(beerNorm) || beerNorm.includes(candidateNorm));
    nameSimilar = lev >= NAME_SIMILAR_THRESHOLD || dice >= NAME_DICE_THRESHOLD || containment;
    if (nameSimilar) evidence.push('name_similar');
  }

  const candidateTokens = new Set([
    ...tokenize(candidateNorm),
    ...tokenize(candidateBrewery),
  ]);
  const beerTokens = new Set([...tokenize(beerNorm), ...tokenize(beerBrewery)]);
  const overlap = jaccard(candidateTokens, beerTokens);
  const tokenOverlap = overlap >= TOKEN_OVERLAP_THRESHOLD;
  if (tokenOverlap && !nameExact && !nameNormalized) evidence.push('token_overlap');

  let score: number;
  if (barcodeExact) {
    score = 95 + (nameExact || nameNormalized ? 3 : 0) + (breweryMatch ? 2 : 0);
  } else if (nameExact) {
    score = 86 + (breweryMatch ? 10 : 0);
  } else if (nameNormalized) {
    score = 80 + (breweryMatch ? 10 : 0);
  } else if (nameSimilar) {
    score = Math.round(58 + 22 * ratio) + (breweryMatch ? 8 : 0);
  } else if (tokenOverlap) {
    score = Math.round(34 + 26 * overlap) + (breweryMatch ? 8 : 0);
  } else {
    return null;
  }
  if (score < SUGGESTION_FLOOR) return null;
  return { score: Math.min(100, score), evidence };
};

// Deterministic ranking: score descending, beer_id ascending on
// ties, capped at MATCH_SUGGESTION_LIMIT.
export const rankSuggestions = (
  candidate: MatchCandidateInput,
  beers: MatchBeerInput[],
  limit: number = MATCH_SUGGESTION_LIMIT,
): MatchSuggestion[] => {
  const scored: MatchSuggestion[] = [];
  for (const beer of beers) {
    const result = scoreMatch(candidate, beer);
    if (!result) continue;
    scored.push({
      beer_id: beer.id,
      name: beer.name,
      brewery_name: beer.brewery_name ?? null,
      abv: beer.abv ?? null,
      barcode: beer.barcode ?? null,
      score: result.score,
      evidence: result.evidence,
    });
  }
  scored.sort((a, b) => b.score - a.score || a.beer_id - b.beer_id);
  return scored.slice(0, limit);
};

export type MatchSuggestionsResult = {
  candidate_id: number;
  suggestions: MatchSuggestion[];
  exhaustive: boolean;
  scanned: number;
  completeness: {
    token_query_complete: boolean;
    catalog_exhaustive: boolean;
    stages_truncated: string[];
  };
};

export type MatchSuggestionsOptions = {
  scanCap?: number;
};

export const resolveScanCap = (opts: MatchSuggestionsOptions = {}): number => {
  if (opts.scanCap !== undefined) return Math.max(1, Math.floor(opts.scanCap));
  const fromEnv = Number(process.env.DISCOVERY_MATCH_SCAN_CAP);
  if (Number.isInteger(fromEnv) && fromEnv >= 1 && fromEnv <= 5000) return fromEnv;
  return DEFAULT_MATCH_SCAN_CAP;
};

const beerSelect = {
  id: true, name: true, abv: true, upc: true,
  brewery: { select: { name: true } },
} as const;

const toBeerInput = (row: any): MatchBeerInput => ({
  id: row.id,
  name: row.name,
  brewery_name: row.brewery ? row.brewery.name : null,
  abv: row.abv ?? null,
  barcode: row.upc ?? null,
});

// Staged, bounded catalog access. Returns null when the candidate
// does not exist (the route maps that to 404). `scanned` counts the
// distinct catalog beers actually scored; `exhaustive` is false when
// the similarity scan was truncated by the cap or could not run.
export const findMatchSuggestions = async (
  prisma: any,
  candidateId: number,
  opts: MatchSuggestionsOptions = {},
): Promise<MatchSuggestionsResult | null> => {
  const candidate = await prisma.discovery_candidates.findUnique({
    where: { id: candidateId },
    select: { id: true, name: true, brewery_name: true, barcode: true },
  });
  if (!candidate) return null;

  const scanCap = resolveScanCap(opts);
  const input: MatchCandidateInput = {
    name: candidate.name,
    brewery_name: candidate.brewery_name ?? null,
    barcode: candidate.barcode ?? null,
  };

  const byId = new Map<number, MatchBeerInput>();
  const stagesTruncated: string[] = [];
  let tokenQueryComplete = false;
  const addRows = (rows: any[]) => {
    for (const row of rows) {
      if (!byId.has(row.id)) byId.set(row.id, toBeerInput(row));
    }
  };

  // Stage 1: exact barcode (beers.upc). Equality lookup.
  const barcode = (candidate.barcode || '').trim();
  if (barcode) {
    const rows = await prisma.beers.findMany({
      where: { upc: barcode },
      select: beerSelect,
      orderBy: { id: 'asc' },
      take: 51,
    });
    if (rows.length > 50) stagesTruncated.push('barcode_exact');
    addRows(rows.slice(0, 50));
  }

  // Stage 2: exact name, case-insensitive. Equality lookup.
  if (candidate.name && candidate.name.trim()) {
    const rows = await prisma.beers.findMany({
      where: { name: { equals: candidate.name.trim(), mode: 'insensitive' } },
      select: beerSelect,
      orderBy: { id: 'asc' },
      take: 51,
    });
    if (rows.length > 50) stagesTruncated.push('name_exact');
    addRows(rows.slice(0, 50));
  }

  // Stage 3: bounded similarity scan over distinctive tokens of the
  // candidate name (budget 4) and brewery (budget 2). One extra row
  // is requested so truncation is detectable.
  let exhaustive = false; // Token retrieval cannot prove that all fuzzy matches were considered.
  const nameTokens = distinctiveTokens(normalizeBeerName(candidate.name), 4);
  const breweryTokens = distinctiveTokens(normalizeBreweryName(candidate.brewery_name || ''), 2);
  const scanTokens = [...nameTokens, ...breweryTokens.filter((t) => !nameTokens.includes(t))];
  if (scanTokens.length === 0) {
    // Nothing to drive a similarity scan with; the whole catalog was
    // NOT considered, so completeness must not be claimed.
    exhaustive = false;
  } else {
    const or: any[] = [];
    for (const token of scanTokens) {
      or.push({ name: { contains: token, mode: 'insensitive' } });
      or.push({ brewery: { name: { contains: token, mode: 'insensitive' } } });
    }
    const rows = await prisma.beers.findMany({
      where: { OR: or },
      select: beerSelect,
      orderBy: { id: 'asc' },
      take: scanCap + 1,
    });
    if (rows.length > scanCap) {
      stagesTruncated.push('similarity_scan');
      exhaustive = false;
      addRows(rows.slice(0, scanCap));
    } else {
      tokenQueryComplete = true;
      addRows(rows);
    }
  }

  const beers = [...byId.values()];
  return {
    candidate_id: candidate.id,
    suggestions: rankSuggestions(input, beers),
    exhaustive,
    scanned: beers.length,
    completeness: {
      token_query_complete: tokenQueryComplete,
      catalog_exhaustive: false,
      stages_truncated: stagesTruncated,
    },
  };
};
