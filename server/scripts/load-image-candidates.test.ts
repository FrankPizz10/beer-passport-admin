// Tests for the candidate loader's classification and dry-run behavior.
// Both the database layer and the URL check are mocked through the
// loader's dependency seam, so these tests need no database and no
// network. The one exception is the checkImageUrl test, which mocks
// the global fetch the real implementation calls.
import {
  checkImageUrl,
  runLoader,
  CandidateInsert,
  LoaderDeps,
} from './load-image-candidates';

const HOSTED_IMAGE = 'https://cdn.example.com/beers/1.jpg';
const HOSTED_DUP = 'https://cdn.example.com/beers/2.jpg';
const HOSTED_PAGE = 'https://example.com/product-page';

const candidates = [
  // Hosted, verified image: inserted.
  { beverage_id: 1, image_url: HOSTED_IMAGE, source_type: 'test', source_url: 'https://example.com/p1' },
  // Hosted, already in beverage_images: skipped as a duplicate.
  { beverage_id: 2, image_url: HOSTED_DUP, source_type: 'test', source_url: 'https://example.com/p2' },
  // Private storage key: inserted, unchecked.
  { beverage_id: 3, storage_key: 'beers/3.jpg', source_type: 'test', source_url: 'https://example.com/p3' },
  // Hosted, but the URL serves a web page: inserted, counted not_image.
  { beverage_id: 4, image_url: HOSTED_PAGE, source_type: 'test', source_url: 'https://example.com/p4' },
  // No locator at all: invalid.
  { beverage_id: 5, source_type: 'test', source_url: 'https://example.com/p5' },
];

const expectedSummary = {
  total: 5,
  inserted: 3,
  skipped_duplicate: 1,
  invalid: 1,
  not_image: 1,
  unreachable: 0,
};

const makeDeps = () => {
  const inserted: CandidateInsert[] = [];
  const deps: LoaderDeps = {
    findExisting: async (beverageId, storageKey) =>
      beverageId === 2 && storageKey === HOSTED_DUP ? { id: 42 } : null,
    insertCandidate: async (data) => {
      inserted.push(data);
    },
    checkImageUrl: async (url) => {
      if (url === HOSTED_PAGE) return { status: 'not_image', contentType: 'text/html' };
      if (url === HOSTED_IMAGE || url === HOSTED_DUP) {
        return { status: 'image', contentType: 'image/jpeg' };
      }
      return { status: 'unreachable', contentType: null };
    },
  };
  return { deps, inserted };
};

describe('load-image-candidates runLoader', () => {
  it('a real run inserts the classified rows and reports the counts', async () => {
    const { deps, inserted } = makeDeps();
    const summary = await runLoader(candidates, deps);
    expect(summary).toEqual(expectedSummary);
    expect(inserted).toHaveLength(3);
    expect(inserted.map((r) => r.beverage_id)).toEqual([1, 3, 4]);
    expect(inserted.every((r) => r.status === 'pending')).toBe(true);
  });

  it('dry-run inserts nothing while reporting the same counts as a real run', async () => {
    const real = makeDeps();
    const realSummary = await runLoader(candidates, real.deps);

    const dry = makeDeps();
    const drySummary = await runLoader(candidates, dry.deps, { dryRun: true });

    expect(drySummary).toEqual(realSummary);
    expect(drySummary).toEqual(expectedSummary);
    expect(dry.inserted).toHaveLength(0);
  });

  it('detects duplicates by beverage_id + storage_key and never re-inserts them', async () => {
    const { deps, inserted } = makeDeps();
    const summary = await runLoader([candidates[1]], deps);
    expect(summary.skipped_duplicate).toBe(1);
    expect(summary.inserted).toBe(0);
    expect(inserted).toHaveLength(0);
  });

  it('classifies a hosted URL that serves a page as not_image and still records it pending', async () => {
    const { deps, inserted } = makeDeps();
    const summary = await runLoader([candidates[3]], deps);
    expect(summary.not_image).toBe(1);
    expect(summary.inserted).toBe(1);
    expect(inserted[0].source_check_status).toBe('not_image');
    expect(inserted[0].source_content_type).toBe('text/html');
    expect(inserted[0].status).toBe('pending');
  });

  it('counts unreachable hosted candidates and invalid rows', async () => {
    const { deps } = makeDeps();
    const summary = await runLoader(
      [
        { beverage_id: 9, image_url: 'https://gone.example.com/x.jpg', source_type: 'test', source_url: 'https://example.com/p9' },
        { beverage_id: -1, image_url: HOSTED_IMAGE, source_type: 'test', source_url: 'https://example.com/bad' },
      ],
      deps,
    );
    expect(summary.unreachable).toBe(1);
    expect(summary.invalid).toBe(1);
    expect(summary.inserted).toBe(1);
  });
});

describe('load-image-candidates checkImageUrl (fetch mocked)', () => {
  const originalFetch = (globalThis as any).fetch;
  afterEach(() => {
    (globalThis as any).fetch = originalFetch;
  });

  const mockFetch = (contentType: string | null, ok = true, status = 200) => {
    (globalThis as any).fetch = jest.fn(async () => ({
      status,
      ok,
      headers: {
        get: (name: string) => (name === 'content-type' ? contentType : null),
      },
    }));
  };

  it('reports image for an image content type', async () => {
    mockFetch('image/png');
    await expect(checkImageUrl('https://x.example/a.png')).resolves.toEqual({
      status: 'image',
      contentType: 'image/png',
    });
  });

  it('reports not_image for a non-image content type', async () => {
    mockFetch('text/html; charset=utf-8');
    const result = await checkImageUrl('https://x.example/page');
    expect(result.status).toBe('not_image');
  });

  it('reports unreachable when fetch throws', async () => {
    (globalThis as any).fetch = jest.fn(async () => {
      throw new Error('network down');
    });
    await expect(checkImageUrl('https://x.example/a.jpg')).resolves.toEqual({
      status: 'unreachable',
      contentType: null,
    });
  });
});
