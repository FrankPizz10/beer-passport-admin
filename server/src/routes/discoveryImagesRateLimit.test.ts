// Discovery image fetch rate limit configuration
// (DISCOVERY_IMAGE_FETCH_RATE_LIMIT):
// - parseImageFetchRateLimit: unset/empty -> the historical default
//   of 30; a positive integer is honored; values above the 600 hard
//   maximum are clamped (flagged so module load can warn); garbage,
//   fractional, zero, and negative values are invalid and fall back
//   to the default rather than silently changing behavior.
// - enforcement: with the limit configured to 3, the first three
//   attempts proceed and the fourth answers 429 with
//   error.retry_after_seconds (and the Retry-After header) computed
//   from the oldest counted attempt leaving the rolling window.
// - counting semantics are preserved: a fetch-level failure outcome
//   consumes budget exactly like a success, because every attempt
//   that reaches the fetcher writes a discovery_image_fetches row.
// The env assignment below must run before any server module is
// required (the limit is parsed once at module load), so this file
// uses require() throughout instead of hoisted imports.
process.env.DISCOVERY_IMAGE_FETCH_RATE_LIMIT = '3';

/* eslint-disable @typescript-eslint/no-var-requires */
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { createApp } = require('../app');
const { createImageStore } = require('../discoveryImageStore');
const { sha256Hex } = require('../discoveryImageFetch');
const {
  parseImageFetchRateLimit,
  IMAGE_FETCH_RATE_LIMIT,
  IMAGE_FETCH_RATE_LIMIT_DEFAULT,
  IMAGE_FETCH_RATE_LIMIT_MAX,
} = require('./discoveryImages');

const ADMIN_UID = 'admin-uid-secret';

const adminDeps = {
  resolveAdminAccess: async () => 'owner' as const,
  verifyIdToken: jest.fn(async () => ({ uid: ADMIN_UID, user_id: ADMIN_UID, admin: true })),
  findUserByUid: jest.fn(async () => ({ id: 1, uid: ADMIN_UID, user_name: 'Admin One' })),
};

const pngBytes = (): Buffer => {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(640, 16);
  buf.writeUInt32BE(480, 20);
  return buf;
};
const PNG = pngBytes();
const PNG_SHA = sha256Hex(PNG);

const successResult = {
  outcome: 'success',
  image: {
    bytes: PNG, sha256: PNG_SHA, contentType: 'image/png',
    width: 640, height: 480, finalUrl: 'https://images.example/ale.png', redirects: 0,
  },
};

// A harness whose rate-limit count reflects the rows actually
// recorded, so the enforcement tests exercise the real interaction
// between attempts, the window count, and the 429 guidance.
const buildRateApp = () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-images-ratelimit-'));
  const store = createImageStore(storeDir);
  const candidate = {
    id: 11, batch_id: 3, candidate_key: 'wikidata:Q123', name: 'Candidate Ale',
    image_url: 'https://images.example/ale.png', image_source: 'wikidata',
    image_license: 'CC BY-SA 4.0', image_decision: null,
    image_decision_fetch_id: null, image_decision_at: null,
  };
  const attempts: any[] = [];
  let fetcherResult: any = successResult;
  let nextFetchedAt: Date | null = null;

  const readPrisma = {
    discovery_candidates: {
      findUnique: jest.fn(async ({ where }: any) => (where.id === candidate.id ? candidate : null)),
    },
    discovery_image_fetches: {
      count: jest.fn(async ({ where }: any) =>
        where && (where.fetched_by !== undefined || where.fetched_by_uid !== undefined)
          ? attempts.length
          : attempts.filter((a) => a.candidate_id === (where && where.candidate_id)).length),
      findFirst: jest.fn(async () => {
        if (!attempts.length) return null;
        return [...attempts].sort((a, b) => a.fetched_at.getTime() - b.fetched_at.getTime())[0];
      }),
      findMany: jest.fn(async () => [...attempts].reverse()),
      findUnique: jest.fn(async ({ where }: any) => attempts.find((a) => a.id === where.id) ?? null),
    },
    discovery_image_decisions: {
      count: jest.fn(async () => 0),
      findMany: jest.fn(async () => []),
      findUnique: jest.fn(async () => null),
    },
  };
  const writePrisma = {
    discovery_image_fetches: {
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: 100 + attempts.length,
          fetched_at: nextFetchedAt ?? new Date(),
          fetcher: { id: 1, user_name: 'Admin One' },
          decision: null,
          ...data,
        };
        nextFetchedAt = null;
        attempts.push(row);
        return row;
      }),
    },
    $transaction: jest.fn(async (fn: any) => fn({})),
  };
  const fetchImage = jest.fn(async () => fetcherResult);
  const app = createApp({
    prisma: readPrisma,
    writePrisma: null,
    discoveryWritePrisma: writePrisma,
    presignGetUrl: null,
    discoveryImageServices: { fetchImage, store },
    ...adminDeps,
  });
  return {
    app, attempts, fetchImage,
    setFetcherResult: (r: any) => { fetcherResult = r; },
    ageNextAttemptBy: (ms: number) => { nextFetchedAt = new Date(Date.now() - ms); },
  };
};

const postFetch = (app: any) =>
  request(app)
    .post('/admin-api/v1/discovery/candidates/11/image-fetches')
    .set('Authorization', 'Bearer test-token')
    .send({});

describe('parseImageFetchRateLimit', () => {
  const parse = (value?: string) => parseImageFetchRateLimit(
    value === undefined ? {} : { DISCOVERY_IMAGE_FETCH_RATE_LIMIT: value },
  );

  it('defaults to 30 when unset or empty', () => {
    expect(parse(undefined)).toMatchObject({
      limit: IMAGE_FETCH_RATE_LIMIT_DEFAULT, source: 'default', clamped: false, invalid: false,
    });
    expect(IMAGE_FETCH_RATE_LIMIT_DEFAULT).toBe(30);
    expect(parse('')).toMatchObject({ limit: 30, source: 'default', invalid: false });
    expect(parse('   ')).toMatchObject({ limit: 30, source: 'default', invalid: false });
  });

  it('honors a valid positive integer', () => {
    expect(parse('120')).toMatchObject({ limit: 120, source: 'env', clamped: false, invalid: false });
    expect(parse(' 42 ')).toMatchObject({ limit: 42, source: 'env' });
    expect(parse('600')).toMatchObject({ limit: 600, source: 'env', clamped: false });
  });

  it('clamps values above the hard maximum of 600', () => {
    expect(IMAGE_FETCH_RATE_LIMIT_MAX).toBe(600);
    expect(parse('601')).toMatchObject({ limit: 600, source: 'env', clamped: true, invalid: false });
    expect(parse('100000')).toMatchObject({ limit: 600, clamped: true });
  });

  it('falls back to the default for garbage, fractional, zero, and negative values', () => {
    for (const bad of ['abc', '3.5', '1e3', '0', '-5', 'NaN', 'Infinity']) {
      expect(parse(bad)).toMatchObject({
        limit: 30, source: 'default', clamped: false, invalid: true,
      });
    }
  });
});

describe('configured rate limit enforcement (DISCOVERY_IMAGE_FETCH_RATE_LIMIT=3)', () => {
  it('exposes the configured limit as the module constant', () => {
    expect(IMAGE_FETCH_RATE_LIMIT).toBe(3);
  });

  it('allows the configured number of attempts, then answers 429 with retry guidance', async () => {
    const h = buildRateApp();
    // Age the first attempt by 30 minutes: when the limit is hit,
    // budget returns when that attempt leaves the 60-minute window,
    // i.e. in roughly 30 minutes (1800 seconds).
    h.ageNextAttemptBy(30 * 60 * 1000);
    for (let i = 0; i < 3; i += 1) {
      const res = await postFetch(h.app);
      expect(res.status).toBe(201);
    }
    expect(h.fetchImage).toHaveBeenCalledTimes(3);
    const res = await postFetch(h.app);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('too_many_requests');
    expect(res.body.error.retry_after_seconds).toBeGreaterThan(1700);
    expect(res.body.error.retry_after_seconds).toBeLessThanOrEqual(1800);
    expect(res.headers['retry-after']).toBe(String(res.body.error.retry_after_seconds));
    // The refused attempt reached neither the fetcher nor the table.
    expect(h.fetchImage).toHaveBeenCalledTimes(3);
    expect(h.attempts).toHaveLength(3);
  });

  it('counts fetch-level failure outcomes toward the limit (semantics preserved)', async () => {
    const h = buildRateApp();
    h.setFetcherResult({ outcome: 'unreachable', detail: 'DNS resolution failed for images.example.' });
    for (let i = 0; i < 3; i += 1) {
      const res = await postFetch(h.app);
      expect(res.status).toBe(201);
      expect(res.body.outcome).toBe('unreachable');
    }
    const res = await postFetch(h.app);
    expect(res.status).toBe(429);
    expect(h.fetchImage).toHaveBeenCalledTimes(3);
  });
});
