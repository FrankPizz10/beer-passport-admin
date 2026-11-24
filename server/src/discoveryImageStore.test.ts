// Content-addressed image store (src/discoveryImageStore.ts): bytes
// land under their SHA-256 with a 2-char shard prefix, identical
// bytes are stored once, and a missing object reads back as null
// (the preview and decision flows treat that as "re-fetch").
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createImageStore } from './discoveryImageStore';
import { sha256Hex } from './discoveryImageFetch';

const pngBytes = (): Buffer => {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(640, 16);
  buf.writeUInt32BE(480, 20);
  return buf;
};

describe('discovery image store', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-image-store-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stores bytes under their sha256 with a shard prefix and reads them back', async () => {
    const store = createImageStore(dir);
    const bytes = pngBytes();
    const sha = await store.put(bytes);
    expect(sha).toBe(sha256Hex(bytes));
    const expected = path.join(dir, sha.slice(0, 2), sha);
    expect(fs.existsSync(expected)).toBe(true);
    const back = await store.get(sha);
    expect(back !== null && back.equals(bytes)).toBe(true);
  });

  it('storing identical bytes twice keeps exactly one object', async () => {
    const store = createImageStore(dir);
    const bytes = pngBytes();
    const first = await store.put(bytes);
    const second = await store.put(bytes);
    expect(second).toBe(first);
    const shardEntries = fs.readdirSync(path.join(dir, first.slice(0, 2)));
    expect(shardEntries).toEqual([first]);
  });

  it('returns null for a missing object and reports unconfigured stores', async () => {
    const store = createImageStore(dir);
    expect(await store.get('a'.repeat(64))).toBeNull();
    const unconfigured = createImageStore(undefined);
    expect(unconfigured.configured).toBe(false);
    expect(await unconfigured.get('a'.repeat(64))).toBeNull();
    await expect(unconfigured.put(pngBytes())).rejects.toThrow(/not configured/);
  });
});
