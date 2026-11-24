// Unit tests for the discovery image uploader: key derivation, the
// S3 checksum conversion, and the retry policy. The S3 client is a
// hand-rolled stub (no aws-sdk-client-mock dependency, no AWS calls
// anywhere): it records every PutObjectCommand it receives and can
// be scripted to fail a chosen number of times.
import { PutObjectCommand } from '@aws-sdk/client-s3';
import {
  createDiscoveryImageUploader, discoveryObjectKey, isTransientUploadError,
  sha256ChecksumBase64, UPLOAD_MAX_ATTEMPTS,
} from './discoveryImageUpload';
import { sha256Hex } from './discoveryImageFetch';

const BYTES = Buffer.from('fake-but-deterministic image bytes');
const SHA = sha256Hex(BYTES);

type StubBehavior = (call: number, command: PutObjectCommand) => Promise<void>;

const makeStubClient = (behavior?: StubBehavior) => {
  const commands: PutObjectCommand[] = [];
  const client = {
    send: async (command: PutObjectCommand) => {
      commands.push(command);
      if (behavior) await behavior(commands.length, command);
      return {};
    },
  };
  return { client, commands };
};

const httpError = (name: string, status: number) => {
  const e = new Error(name) as Error & { $metadata?: unknown };
  e.name = name;
  e.$metadata = { httpStatusCode: status };
  return e;
};

const noSleep = async () => undefined;

describe('discoveryObjectKey', () => {
  it('derives the content-addressed key with the 2-char shard', () => {
    expect(discoveryObjectKey(SHA)).toBe(`discovery/${SHA.slice(0, 2)}/${SHA}`);
    expect(discoveryObjectKey('ab'.repeat(32))).toBe(`discovery/ab/${'ab'.repeat(32)}`);
  });

  it('is deterministic: the same hash always yields the same key (retry-safe)', () => {
    expect(discoveryObjectKey(SHA)).toBe(discoveryObjectKey(SHA));
  });

  it('rejects an invalid sha256', () => {
    expect(() => discoveryObjectKey('not-a-hash')).toThrow(/invalid sha256/);
    expect(() => discoveryObjectKey('AB'.repeat(32))).toThrow(/invalid sha256/);
    expect(() => discoveryObjectKey('')).toThrow(/invalid sha256/);
  });
});

describe('sha256ChecksumBase64', () => {
  it('matches the known-answer vector for the empty-string hash', () => {
    // sha256("") in hex and in base64 are both published constants.
    expect(sha256ChecksumBase64('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'))
      .toBe('47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=');
  });

  it('encodes the raw hash bytes, not the hex text', () => {
    const b64 = sha256ChecksumBase64(SHA);
    expect(Buffer.from(b64, 'base64').toString('hex')).toBe(SHA);
    expect(b64).not.toBe(Buffer.from(SHA, 'utf8').toString('base64'));
  });

  it('rejects an invalid sha256', () => {
    expect(() => sha256ChecksumBase64('zz'.repeat(32))).toThrow(/invalid sha256/);
  });
});

describe('isTransientUploadError', () => {
  it('treats 5xx and 429 responses as transient', () => {
    expect(isTransientUploadError(httpError('InternalError', 500))).toBe(true);
    expect(isTransientUploadError(httpError('Whatever', 503))).toBe(true);
    expect(isTransientUploadError(httpError('SlowDown', 429))).toBe(true);
  });

  it('treats throttling and network error names as transient even without metadata', () => {
    expect(isTransientUploadError(new Error('SlowDown'))).toBe(false); // message is not a name
    const named = new Error('boom'); named.name = 'Throttling';
    expect(isTransientUploadError(named)).toBe(true);
    const coded = new Error('boom') as Error & { code?: string }; coded.code = 'ECONNRESET';
    expect(isTransientUploadError(coded)).toBe(true);
  });

  it('treats deterministic failures as non-transient', () => {
    expect(isTransientUploadError(httpError('AccessDenied', 403))).toBe(false);
    expect(isTransientUploadError(httpError('NoSuchBucket', 404))).toBe(false);
    expect(isTransientUploadError(httpError('BadDigest', 400))).toBe(false);
    expect(isTransientUploadError(new Error('plain failure'))).toBe(false);
    expect(isTransientUploadError(null)).toBe(false);
    expect(isTransientUploadError('a string')).toBe(false);
  });
});

describe('createDiscoveryImageUploader', () => {
  it('sends one PutObject with the derived key, verified content type, and SHA-256 checksum', async () => {
    const { client, commands } = makeStubClient();
    const upload = createDiscoveryImageUploader({ bucket: 'image-bucket', client, sleep: noSleep });
    const key = await upload({ bytes: BYTES, sha256: SHA, contentType: 'image/png' });
    expect(key).toBe(`discovery/${SHA.slice(0, 2)}/${SHA}`);
    expect(commands).toHaveLength(1);
    const input = commands[0].input;
    expect(input.Bucket).toBe('image-bucket');
    expect(input.Key).toBe(key);
    expect(input.ContentType).toBe('image/png');
    expect(input.ChecksumSHA256).toBe(sha256ChecksumBase64(SHA));
    expect(Buffer.isBuffer(input.Body)).toBe(true);
    expect((input.Body as Buffer).equals(BYTES)).toBe(true);
  });

  it('refuses bytes that do not hash to the claimed sha256, without sending', async () => {
    const { client, commands } = makeStubClient();
    const upload = createDiscoveryImageUploader({ bucket: 'image-bucket', client, sleep: noSleep });
    await expect(
      upload({ bytes: BYTES, sha256: 'cd'.repeat(32), contentType: 'image/png' }),
    ).rejects.toThrow(/does not match the verified hash/);
    expect(commands).toHaveLength(0);
  });

  it('retries transient failures with exponential backoff and then succeeds', async () => {
    const delays: number[] = [];
    const { client, commands } = makeStubClient(async (call) => {
      if (call <= 2) throw httpError('ServiceUnavailable', 503);
    });
    const upload = createDiscoveryImageUploader({
      bucket: 'image-bucket', client, baseDelayMs: 100,
      sleep: async (ms) => { delays.push(ms); },
    });
    const key = await upload({ bytes: BYTES, sha256: SHA, contentType: 'image/jpeg' });
    expect(key).toBe(discoveryObjectKey(SHA));
    expect(commands).toHaveLength(3);
    expect(delays).toEqual([100, 200]);
  });

  it('gives up after the bounded attempts when failures stay transient', async () => {
    const { client, commands } = makeStubClient(async () => {
      throw httpError('SlowDown', 429);
    });
    const upload = createDiscoveryImageUploader({ bucket: 'image-bucket', client, sleep: noSleep });
    await expect(
      upload({ bytes: BYTES, sha256: SHA, contentType: 'image/png' }),
    ).rejects.toThrow('SlowDown');
    expect(commands).toHaveLength(UPLOAD_MAX_ATTEMPTS);
  });

  it('does not retry a deterministic failure', async () => {
    const { client, commands } = makeStubClient(async () => {
      throw httpError('AccessDenied', 403);
    });
    const upload = createDiscoveryImageUploader({ bucket: 'image-bucket', client, sleep: noSleep });
    await expect(
      upload({ bytes: BYTES, sha256: SHA, contentType: 'image/png' }),
    ).rejects.toThrow('AccessDenied');
    expect(commands).toHaveLength(1);
  });

  it('requires a bucket', () => {
    expect(() => createDiscoveryImageUploader({ bucket: '' })).toThrow(/bucket is required/);
  });
});
