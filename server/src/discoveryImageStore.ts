// Content-addressed store for fetched discovery candidate images
// (hub decision 006 revision 2). The bytes a reviewer previews, and
// that an image decision binds to, live here under their SHA-256:
//   <root>/<first 2 hex chars>/<full sha256>
// The root comes from DISCOVERY_IMAGE_STORE (a directory on the API
// host; see docs/DISCOVERY_HUB_RUNBOOK.md for sizing and permissions).
// Identical bytes are stored exactly once: put() of an existing hash
// is a no-op. The store holds bytes for REVIEWED candidates only; it
// is not a catalog asset store, and deleting the whole directory is
// the documented teardown (previews then 404 and any decision flow
// must re-fetch, which is the intended behavior: bytes are evidence).
import * as fs from 'fs';
import * as path from 'path';
import { sha256Hex } from './discoveryImageFetch';

export interface ImageStore {
  configured: boolean;
  root: string | null;
  put: (bytes: Buffer) => Promise<string>;
  get: (sha256: string) => Promise<Buffer | null>;
  objectPath: (sha256: string) => string;
}

const SHA_PATTERN = /^[0-9a-f]{64}$/;

export const createImageStore = (root: string | null | undefined): ImageStore => {
  const configured = typeof root === 'string' && root.length > 0;
  const base = configured ? (root as string) : '';

  const objectPath = (sha256: string): string => {
    if (!SHA_PATTERN.test(sha256)) throw new Error(`Invalid sha256 for the image store: ${sha256}`);
    return path.join(base, sha256.slice(0, 2), sha256);
  };

  const put = async (bytes: Buffer): Promise<string> => {
    if (!configured) throw new Error('DISCOVERY_IMAGE_STORE is not configured.');
    const sha256 = sha256Hex(bytes);
    const target = objectPath(sha256);
    try {
      await fs.promises.access(target, fs.constants.F_OK);
      return sha256; // Identical bytes are already stored.
    } catch {
      // Not stored yet: write via a temp file + rename so a concurrent
      // reader never sees a partial object.
    }
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await fs.promises.writeFile(tmp, bytes);
    await fs.promises.rename(tmp, target);
    return sha256;
  };

  const get = async (sha256: string): Promise<Buffer | null> => {
    if (!configured) return null;
    try {
      return await fs.promises.readFile(objectPath(sha256));
    } catch {
      return null;
    }
  };

  return { configured, root: configured ? base : null, put, get, objectPath };
};

export const getDiscoveryImageStore = (): ImageStore =>
  createImageStore(process.env.DISCOVERY_IMAGE_STORE);
