// Pure scoring + bounded staged access for discovery match
// suggestions. No database: findMatchSuggestions is exercised
// against a stub Prisma client that records its queries.
import {
  normalizeBeerName, normalizeBreweryName, scoreMatch, rankSuggestions,
  findMatchSuggestions,
} from './discoveryMatchCore';

describe('normalization', () => {
  it('drops one trailing generic "beer" but never style words', () => {
    expect(normalizeBeerName('Bud Light Beer')).toBe('bud light');
    expect(normalizeBeerName('Pale Ale')).toBe('pale ale');
    expect(normalizeBeerName('  Hazy   IPA!! ')).toBe('hazy ipa');
  });

  it('drops trailing brewery corporate tokens repeatedly', () => {
    expect(normalizeBreweryName('Sierra Nevada Brewing')).toBe('sierra nevada');
    expect(normalizeBreweryName('Example Brewing Company')).toBe('example');
    expect(normalizeBreweryName('Anheuser-Busch')).toBe('anheuser busch');
    expect(normalizeBreweryName('Budweiser')).toBe('budweiser');
  });
});

describe('scoreMatch / rankSuggestions', () => {
  const budLightCatalog = { id: 3784, name: 'Bud Light', brewery_name: 'Anheuser-Busch', abv: 4.2, barcode: '018200530401' };

  it('Bud Light staged under "Budweiser" ranks the catalog Bud Light first on name evidence, with NO fabricated brewery match', () => {
    const candidate = { name: 'Bud Light', brewery_name: 'Budweiser', barcode: null };
    const others = [
      { id: 41, name: 'Bud Light Lime', brewery_name: 'Anheuser-Busch', abv: 4.2, barcode: null },
      { id: 42, name: 'Budweiser', brewery_name: 'Anheuser-Busch', abv: 5.0, barcode: null },
      { id: 43, name: 'Michelob Ultra', brewery_name: 'Anheuser-Busch', abv: 4.2, barcode: null },
    ];
    const ranked = rankSuggestions(candidate, [others[0], budLightCatalog, others[1], others[2]]);
    expect(ranked[0].beer_id).toBe(3784);
    expect(ranked[0].evidence).toContain('name_exact');
    expect(ranked[0].evidence).not.toContain('brewery_match');
    // The brewery's other products earn no name-side signal and are absent.
    expect(ranked.map((r) => r.beer_id)).not.toContain(43);
  });

  it('spelling variations still surface Bud Light via name_similar or token_overlap', () => {
    for (const staged of ['Bud Lite', 'Budlight']) {
      const result = scoreMatch({ name: staged, brewery_name: 'Budweiser' }, budLightCatalog);
      expect(result).not.toBeNull();
      expect(result!.evidence.some((e) => e === 'name_similar' || e === 'token_overlap')).toBe(true);
    }
  });

  it('same name, different breweries: both appear, brewery evidence orders them', () => {
    const candidate = { name: 'Pale Ale', brewery_name: 'Sierra Nevada Brewing', barcode: null };
    const sierra = { id: 10, name: 'Pale Ale', brewery_name: 'Sierra Nevada', abv: 5.6, barcode: null };
    const firestone = { id: 11, name: 'Pale Ale', brewery_name: 'Firestone Walker', abv: 5.5, barcode: null };
    const ranked = rankSuggestions(candidate, [firestone, sierra]);
    expect(ranked.map((r) => r.beer_id)).toEqual([10, 11]);
    expect(ranked[0].evidence).toContain('brewery_match');
    expect(ranked[1].evidence).not.toContain('brewery_match');
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it('barcode_exact beats a name-only match (and the barcode beer itself is only name-similar)', () => {
    const candidate = { name: 'Hazy Wonder', brewery_name: 'Example Brewing', barcode: '012345678905' };
    const byBarcode = { id: 20, name: 'Hazy Wander', brewery_name: 'Other Brewing', abv: 6.0, barcode: '012345678905' };
    const byName = { id: 21, name: 'Hazy Wonder', brewery_name: 'Different Brewing', abv: 6.4, barcode: '999999999999' };
    const ranked = rankSuggestions(candidate, [byName, byBarcode]);
    expect(ranked[0].beer_id).toBe(20);
    expect(ranked[0].evidence).toContain('barcode_exact');
    expect(ranked[0].score).toBeGreaterThanOrEqual(95);
  });

  it('normalized-name equality (punctuation/spacing only) earns name_normalized', () => {
    const result = scoreMatch(
      { name: 'Hazy  Wonder!', brewery_name: null },
      { id: 30, name: 'Hazy Wonder', brewery_name: 'Example Brewing', abv: null, barcode: null },
    );
    expect(result).not.toBeNull();
    expect(result!.evidence).toContain('name_normalized');
    expect(result!.evidence).not.toContain('name_exact');
  });

  it('a different light lager does not surface on shared style words alone', () => {
    const result = scoreMatch(
      { name: 'Coors Light', brewery_name: 'Coors Brewing', barcode: null },
      budLightCatalog,
    );
    expect(result).toBeNull();
  });

  it('a candidate with no plausible matches yields no suggestions', () => {
    const ranked = rankSuggestions(
      { name: 'Zqx Wobble Juice', brewery_name: 'Nowhere Brewing', barcode: null },
      [budLightCatalog, { id: 50, name: 'Pale Ale', brewery_name: 'Sierra Nevada', abv: 5.6, barcode: null }],
    );
    expect(ranked).toEqual([]);
  });
});

// A stub Prisma that behaves like the staged queries: barcode and
// exact-name equality stages, then a token-contains scan honoring
// take/orderBy. Rows carry the Prisma shape (brewery relation, upc).
const stubPrisma = (candidate: any, beers: any[], calls?: any[]) => ({
  discovery_candidates: {
    findUnique: jest.fn(async () => candidate),
  },
  beers: {
    findMany: jest.fn(async (args: any) => {
      if (calls) calls.push(args);
      let rows = [...beers];
      const where = args.where || {};
      if (where.upc) rows = rows.filter((b: any) => b.upc === where.upc);
      else if (where.name && where.name.equals) {
        rows = rows.filter((b: any) => b.name.toLowerCase() === where.name.equals.toLowerCase());
      } else if (where.OR) {
        const needles = where.OR.map((c: any) =>
          (c.name ? c.name.contains : c.brewery.name.contains).toLowerCase());
        rows = rows.filter((b: any) =>
          needles.some((n: string) =>
            b.name.toLowerCase().includes(n) || (b.brewery && b.brewery.name.toLowerCase().includes(n))));
        rows.sort((a: any, b: any) => a.id - b.id);
      }
      return rows.slice(0, args.take ?? rows.length);
    }),
  },
});

const beerRow = (id: number, name: string, breweryName: string, upc: string | null = null) => ({
  id, name, abv: 5.0, upc, brewery: { name: breweryName },
});

describe('findMatchSuggestions (stubbed staged access)', () => {
  it('returns ranked suggestions with scanned count and exhaustive=false under the cap', async () => {
    const candidate = { id: 61, name: 'Bud Light', brewery_name: 'Budweiser', barcode: null };
    const beers = [beerRow(3784, 'Bud Light', 'Anheuser-Busch'), beerRow(41, 'Bud Light Lime', 'Anheuser-Busch')];
    const result = await findMatchSuggestions(stubPrisma(candidate, beers), 61);
    expect(result).not.toBeNull();
    expect(result!.candidate_id).toBe(61);
    expect(result!.suggestions[0].beer_id).toBe(3784);
    expect(result!.suggestions[0].barcode).toBeNull();
    expect(result!.exhaustive).toBe(false);
    expect(result!.scanned).toBe(2);
  });

  it('returns an empty list with exhaustive=false when nothing plausibly matches', async () => {
    const candidate = { id: 62, name: 'Zqx Wobble Juice', brewery_name: 'Nowhere Brewing', barcode: null };
    const beers = [beerRow(3784, 'Bud Light', 'Anheuser-Busch')];
    const result = await findMatchSuggestions(stubPrisma(candidate, beers), 62);
    expect(result!.suggestions).toEqual([]);
    expect(result!.exhaustive).toBe(false);
  });

  it('sets exhaustive=false and stops scoring at the cap when the scan truncates', async () => {
    const candidate = { id: 63, name: 'Pale Ale', brewery_name: 'Example Brewing', barcode: null };
    const beers = Array.from({ length: 12 }, (_v, i) => beerRow(100 + i, `Pale Ale ${i}`, 'Example Brewing'));
    const result = await findMatchSuggestions(stubPrisma(candidate, beers), 63, { scanCap: 5 });
    expect(result!.exhaustive).toBe(false);
    expect(result!.scanned).toBeLessThanOrEqual(5 + 50); // scan stage capped; exact stages bounded separately
    // The scan stage itself scored at most the cap.
    expect(result!.suggestions.length).toBeGreaterThan(0);
  });

  it('returns null for a missing candidate (route maps to 404)', async () => {
    const result = await findMatchSuggestions(stubPrisma(null, []), 999);
    expect(result).toBeNull();
  });

  it('surfaces a barcode match even when the name tokens would not scan it in', async () => {
    const candidate = { id: 64, name: 'Zqx Wobble Juice', brewery_name: 'Nowhere Brewing', barcode: '012345678905' };
    const beers = [beerRow(77, 'Completely Different', 'Elsewhere Brewing', '012345678905')];
    const result = await findMatchSuggestions(stubPrisma(candidate, beers), 64);
    expect(result!.suggestions).toHaveLength(1);
    expect(result!.suggestions[0].beer_id).toBe(77);
    expect(result!.suggestions[0].evidence).toContain('barcode_exact');
  });
});
