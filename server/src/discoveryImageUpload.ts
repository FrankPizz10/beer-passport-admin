// Upload of hash-verified discovery image bytes to the private image
// bucket, used ONLY by the operator import executor
// (server/scripts/import-discovery-manifest.ts). The admin API never
// imports this module: the API's signing identity stays GetObject-only
// (see imageStorage.ts), and uploads run under the OPERATOR identity
// that runs the executor process, with credentials resolved through
// the SDK default chain for that process. Nothing here creates or
// widens any AWS permission; the narrowly scoped policy an operator
// identity needs is documented in
// docs/ci-cd/discovery-image-upload-policy.example.json (s3:PutObject
// on the discovery/ prefix of the one bucket only).
//
// Bucket and region come from the same environment the presigned read
// path uses (imageStorageConfigFromEnv): ADMIN_IMAGE_BUCKET, and
// ADMIN_IMAGE_REGION with AWS_REGION as the fallback. The read path
// presigns GETs for bare storage keys; the keys written here are
// exactly the bare keys it resolves.
//
// Key layout is content-addressed, mirroring the local Phase 4 store:
//   discovery/<first 2 hex chars of sha256>/<full sha256>
// A retry, or a second import of the same bytes, therefore targets
// the same key with identical content, which is what makes the
// executor's upload step safe to repeat. Every PutObject also sends
// ChecksumSHA256 (the base64 form of the verified hash), so S3
// itself rejects any bytes that do not match the verified hash.
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { imageStorageConfigFromEnv } from './imageStorage';
import { sha256Hex } from './discoveryImageFetch';

export const DISCOVERY_OBJECT_PREFIX = 'discovery';

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export interface ImageUploadInput {
  bytes: Buffer;
  // The verified SHA-256 (lowercase hex) of `bytes`: the hash the
  // Phase 4 image decision approved and the import re-fetch matched.
  sha256: string;
  // The verified content type (from the fetcher's magic-byte sniff).
  contentType: string;
}

// Resolves to the object key the bytes were stored under.
export type UploadImageFn = (image: ImageUploadInput) => Promise<string>;

export const discoveryObjectKey = (sha256: string): string => {
  if (!SHA256_HEX_PATTERN.test(sha256 || '')) {
    throw new Error(`cannot derive a discovery object key from an invalid sha256: ${sha256}`);
  }
  return `${DISCOVERY_OBJECT_PREFIX}/${sha256.slice(0, 2)}/${sha256}`;
};

// S3's ChecksumSHA256 takes the base64 encoding of the raw hash
// bytes, not of the hex text.
export const sha256ChecksumBase64 = (sha256: string): string => {
  if (!SHA256_HEX_PATTERN.test(sha256 || '')) {
    throw new Error(`cannot build an S3 checksum from an invalid sha256: ${sha256}`);
  }
  return Buffer.from(sha256, 'hex').toString('base64');
};

// Retry policy: at most UPLOAD_MAX_ATTEMPTS sends per image, with
// exponential backoff (base, 2x base, ...) between attempts, and
// only for transient failures (throttling, 5xx, timeouts, network
// errors). Deterministic failures (access denied, no such bucket,
// bad digest) are never retried: they cannot succeed on a second
// try and the import should abort immediately.
export const UPLOAD_MAX_ATTEMPTS = 3;
export const UPLOAD_BASE_DELAY_MS = 250;

const TRANSIENT_ERROR_NAMES = new Set([
  'Throttling',
  'ThrottlingException',
  'RequestThrottled',
  'SlowDown',
  'InternalError',
  'InternalFailure',
  'ServiceUnavailable',
  'RequestTimeout',
  'RequestTimedOut',
  'TimeoutError',
  'NetworkingError',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
]);

export const isTransientUploadError = (e: unknown): boolean => {
  if (!e || typeof e !== 'object') return false;
  const status = (e as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode;
  if (typeof status === 'number' && (status >= 500 || status === 429)) return true;
  const name = (e as { name?: unknown }).name;
  if (typeof name === 'string' && TRANSIENT_ERROR_NAMES.has(name)) return true;
  const code = (e as { code?: unknown }).code;
  if (typeof code === 'string' && TRANSIENT_ERROR_NAMES.has(code)) return true;
  return false;
};

// The minimal client seam: the real AWS SDK S3Client satisfies it,
// and unit tests substitute a stub without any AWS calls.
export interface PutObjectClient {
  send: (command: PutObjectCommand) => Promise<unknown>;
}

export interface DiscoveryUploaderOptions {
  bucket: string;
  region?: string;
  client?: PutObjectClient;
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const createDiscoveryImageUploader = (options: DiscoveryUploaderOptions): UploadImageFn => {
  if (!options.bucket) throw new Error('a bucket is required to create a discovery image uploader.');
  const client: PutObjectClient =
    options.client ?? (new S3Client(options.region ? { region: options.region } : {}) as PutObjectClient);
  const maxAttempts = options.maxAttempts ?? UPLOAD_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? UPLOAD_BASE_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;

  return async (image: ImageUploadInput): Promise<string> => {
    // Defensive re-verification at the boundary: the executor has
    // already matched these bytes against the approved hash, and the
    // key and the S3 checksum both derive from that hash, so bytes
    // that do not hash to it must never be uploaded under it.
    const actual = sha256Hex(image.bytes);
    if (actual !== image.sha256) {
      throw new Error(
        `refusing to upload image bytes whose sha256 (${actual}) does not match the verified hash (${image.sha256}).`,
      );
    }
    const key = discoveryObjectKey(image.sha256);
    const command = new PutObjectCommand({
      Bucket: options.bucket,
      Key: key,
      Body: image.bytes,
      ContentType: image.contentType,
      ChecksumSHA256: sha256ChecksumBase64(image.sha256),
    });
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await client.send(command);
        return key;
      } catch (e) {
        lastError = e;
        if (attempt >= maxAttempts || !isTransientUploadError(e)) throw e;
        await sleep(baseDelayMs * 2 ** (attempt - 1));
      }
    }
    throw lastError;
  };
};

// The uploader for the executor process, or null when the image
// bucket is not configured in the environment. A null here is NOT an
// error by itself: the executor refuses only when a manifest
// actually carries images (see runImport's image_upload refusal).
export const getDefaultDiscoveryUploader = (): UploadImageFn | null => {
  const config = imageStorageConfigFromEnv();
  return config
    ? createDiscoveryImageUploader({ bucket: config.bucket, region: config.region })
    : null;
};
