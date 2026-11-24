import { parseReviewIntent, ReviewIntentError } from './discoveryReviewIntent';

const beer = {
  name: 'Bud Light', brewery_name: 'Budweiser', style: null,
  abv: 3.2123353678124, ibu: null, barcode: '01810622', description: null,
};

describe('review intent validation', () => {
  it('accepts staged fields and explicit edits without changing the source object', () => {
    const result = parseReviewIntent({ mode: 'new_beer', beer: { ...beer, abv: 4.2 } });
    expect(result).toEqual({ mode: 'new_beer', beer: { ...beer, abv: 4.2 } });
    expect(beer.abv).toBe(3.2123353678124);
  });

  it('requires an explicit existing beer target for image-only intent', () => {
    expect(parseReviewIntent({ mode: 'image_only', target_beer_id: 42 })).toEqual({ mode: 'image_only', target_beer_id: 42 });
    for (const input of [0, -1, 1.5, '42', null]) {
      expect(() => parseReviewIntent({ mode: 'image_only', target_beer_id: input })).toThrow(ReviewIntentError);
    }
    expect(() => parseReviewIntent({ mode: 'image_only', target_beer_id: 42, beer })).toThrow(ReviewIntentError);
  });

  it('preserves supplied text instead of silently rewriting an accepted value', () => {
    const result = parseReviewIntent({ mode: 'new_beer', beer: { ...beer, name: ' Bud Light ' } });
    expect(result).toEqual({ mode: 'new_beer', beer: { ...beer, name: ' Bud Light ' } });
  });

  it('rejects missing, unknown and invalid field values', () => {
    expect(() => parseReviewIntent({ mode: 'new_beer', beer: { ...beer, name: ' ' } })).toThrow(ReviewIntentError);
    expect(() => parseReviewIntent({ mode: 'new_beer', beer: { ...beer, abv: NaN } })).toThrow(ReviewIntentError);
    expect(() => parseReviewIntent({ mode: 'new_beer', beer: { ...beer, abv: 101 } })).toThrow(ReviewIntentError);
    expect(() => parseReviewIntent({ mode: 'new_beer', beer: { ...beer, extra: true } })).toThrow(ReviewIntentError);
    const { style: _style, ...missing } = beer;
    expect(() => parseReviewIntent({ mode: 'new_beer', beer: missing })).toThrow(ReviewIntentError);
  });
});
