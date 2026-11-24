// SSRF battery for the restricted discovery image fetcher
// (src/discoveryImageFetch.ts). Everything runs against injected
// seams: no network, no DNS. The battery covers every documented
// fetch restriction in decision 006 revision 2 / issues/001
// section 4, plus success cases per format and the address
// validator's range table.
import * as crypto from 'crypto';
import {
  createRestrictedFetcher,
  parseFetchUrl,
  FetchRefusedError,
  blockedAddressReason,
  sniffImageFormat,
  imageDimensions,
  FetchSeams,
  TransportResponse,
  FETCH_MAX_REDIRECTS,
  FETCH_MAX_BYTES,
} from './discoveryImageFetch';

// --- Image fixtures -------------------------------------------------

const pngBytes = (width = 640, height = 480): Buffer => {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
};

const jpegBytes = (width = 320, height = 200): Buffer => {
  const app0 = Buffer.alloc(20);
  app0[0] = 0xff; app0[1] = 0xd8; // SOI
  app0[2] = 0xff; app0[3] = 0xe0; // APP0
  app0.writeUInt16BE(16, 4); // segment length, includes its own 2 bytes
  const sof = Buffer.alloc(19);
  sof[0] = 0xff; sof[1] = 0xc0; // SOF0
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([app0, sof]);
};

const gifBytes = (width = 16, height = 16): Buffer => {
  const buf = Buffer.alloc(13);
  buf.write('GIF89a', 0, 'ascii');
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
};

const webpBytes = (width = 1024, height = 768): Buffer => {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(22, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8X', 12, 'ascii');
  buf.writeUInt32LE(10, 16);
  const w = width - 1;
  const h = height - 1;
  buf[24] = w & 0xff; buf[25] = (w >>> 8) & 0xff; buf[26] = (w >>> 16) & 0xff;
  buf[27] = h & 0xff; buf[28] = (h >>> 8) & 0xff; buf[29] = (h >>> 16) & 0xff;
  return buf;
};

const avifBytes = (): Buffer => {
  const buf = Buffer.alloc(24);
  buf.writeUInt32BE(24, 0);
  buf.write('ftyp', 4, 'ascii');
  buf.write('avif', 8, 'ascii');
  buf.write('avif', 12, 'ascii');
  return buf;
};

// --- Seam helpers ---------------------------------------------------

const chunked = (buf: Buffer, size = 5): AsyncIterable<Buffer> => ({
  [Symbol.asyncIterator]: async function* () {
    for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
  },
});

const ok = (buf: Buffer, contentType: string): TransportResponse => ({
  statusCode: 200,
  headers: { 'content-type': contentType },
  body: chunked(buf),
});

const redirectTo = (location: string): TransportResponse => ({
  statusCode: 302,
  headers: { location },
  body: chunked(Buffer.alloc(0)),
});

interface SeamScript {
  resolveMap?: Record<string, string[]>;
  onRequest: (url: URL, call: number) => TransportResponse | Promise<TransportResponse>;
}

const seamsFor = (script: SeamScript): FetchSeams => ({
  resolve: async (hostname: string) => {
    if (script.resolveMap && hostname in script.resolveMap) return script.resolveMap[hostname];
    return ['93.184.216.34']; // a public address
  },
  transport: async ({ url }) => script.onRequest(url, 0),
});

const scriptedTransport = (
  handler: (url: URL, calls: URL[]) => TransportResponse | Promise<TransportResponse>,
): SeamScript['onRequest'] => {
  const calls: URL[] = [];
  return (url: URL) => {
    calls.push(url);
    return handler(url, calls);
  };
};

// --- Address validation ----------------------------------------------

describe('blockedAddressReason', () => {
  const blocked = [
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254',
    '172.16.0.1', '172.31.255.255', '192.0.0.1', '192.0.2.1', '192.168.1.1',
    '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1',
    '::', '::1', 'fe80::1', 'fd00::1', 'fc00::1', 'ff02::1', '100::1',
    '2001:db8::1', '64:ff9b::10.0.0.1', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
  ];
  const allowed = [
    '8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '192.169.0.1',
    '2606:4700:4700::1111', '::ffff:8.8.8.8',
  ];
  it.each(blocked)('blocks %s', (ip) => {
    expect(blockedAddressReason(ip)).not.toBeNull();
  });
  it.each(allowed)('allows %s', (ip) => {
    expect(blockedAddressReason(ip)).toBeNull();
  });
});

// --- URL shape refusals (pre-fetch) ----------------------------------

describe('parseFetchUrl', () => {
  it('refuses credentialed URLs', () => {
    expect(() => parseFetchUrl('https://user:pass@example.com/x.png')).toThrow(FetchRefusedError);
  });
  it('refuses non-http schemes', () => {
    expect(() => parseFetchUrl('ftp://example.com/x.png')).toThrow(FetchRefusedError);
    expect(() => parseFetchUrl('file:///etc/passwd')).toThrow(FetchRefusedError);
  });
  it('refuses unparseable references', () => {
    expect(() => parseFetchUrl('not a url')).toThrow(FetchRefusedError);
  });
  it('accepts plain http and https URLs', () => {
    expect(parseFetchUrl('https://example.com/x.png').protocol).toBe('https:');
    expect(parseFetchUrl('http://example.com/x.png').protocol).toBe('http:');
  });
});

// --- The SSRF battery --------------------------------------------------

describe('restricted fetcher: SSRF battery', () => {
  it('blocks a private IP literal URL without any transport call', async () => {
    let transported = false;
    const fetchImage = createRestrictedFetcher({
      resolve: async () => { throw new Error('resolve must not be called for IP literals'); },
      transport: async () => { transported = true; return ok(pngBytes(), 'image/png'); },
    });
    const result = await fetchImage('http://127.0.0.1/secret.png');
    expect(result.outcome).toBe('dns_blocked');
    expect(transported).toBe(false);
  });

  it('blocks the cloud metadata address literal', async () => {
    const fetchImage = createRestrictedFetcher(seamsFor({ onRequest: async () => ok(pngBytes(), 'image/png') }));
    const result = await fetchImage('http://169.254.169.254/latest/meta-data');
    expect(result.outcome).toBe('dns_blocked');
  });

  it('blocks an IPv6 loopback literal', async () => {
    const fetchImage = createRestrictedFetcher(seamsFor({ onRequest: async () => ok(pngBytes(), 'image/png') }));
    const result = await fetchImage('http://[::1]/x.png');
    expect(result.outcome).toBe('dns_blocked');
  });

  it('blocks a hostname resolving to a private address', async () => {
    const fetchImage = createRestrictedFetcher(seamsFor({
      resolveMap: { 'evil.example': ['10.0.0.5'] },
      onRequest: async () => ok(pngBytes(), 'image/png'),
    }));
    const result = await fetchImage('https://evil.example/x.png');
    expect(result.outcome).toBe('dns_blocked');
  });

  it('blocks when ANY resolved address is private, even with a public one first', async () => {
    const fetchImage = createRestrictedFetcher(seamsFor({
      resolveMap: { 'mixed.example': ['8.8.8.8', '192.168.0.1'] },
      onRequest: async () => ok(pngBytes(), 'image/png'),
    }));
    const result = await fetchImage('https://mixed.example/x.png');
    expect(result.outcome).toBe('dns_blocked');
  });

  it('re-validates at every redirect hop: hop 2 resolving private is blocked', async () => {
    const fetchImage = createRestrictedFetcher(seamsFor({
      resolveMap: { 'hop2.example': ['172.16.5.5'] },
      onRequest: scriptedTransport((url) => {
        if (url.hostname === 'origin.example') return redirectTo('https://hop2.example/x.png');
        return ok(pngBytes(), 'image/png');
      }),
    }));
    const result = await fetchImage('https://origin.example/x.png');
    expect(result.outcome).toBe('dns_blocked');
  });

  it('refuses an https -> http downgrade redirect', async () => {
    const fetchImage = createRestrictedFetcher(seamsFor({
      onRequest: scriptedTransport((url) => {
        if (url.protocol === 'https:') return redirectTo('http://origin.example/x.png');
        return ok(pngBytes(), 'image/png');
      }),
    }));
    const result = await fetchImage('https://origin.example/x.png');
    expect(result.outcome).toBe('downgrade_blocked');
  });

  it('refuses a redirect chain longer than the cap', async () => {
    const fetchImage = createRestrictedFetcher(seamsFor({
      onRequest: scriptedTransport((url, calls) => redirectTo(`https://origin.example/hop-${calls.length}.png`)),
    }));
    const result = await fetchImage('https://origin.example/hop-0.png');
    expect(result.outcome).toBe('redirect_blocked');
    expect(FETCH_MAX_REDIRECTS).toBe(3);
  });

  it('refuses a redirect to a credentialed URL', async () => {
    const fetchImage = createRestrictedFetcher(seamsFor({
      onRequest: scriptedTransport(() => redirectTo('https://user:pass@origin.example/x.png')),
    }));
    const result = await fetchImage('https://origin.example/x.png');
    expect(result.outcome).toBe('redirect_blocked');
  });

  it('rejects a non-image final Content-Type', async () => {
    const fetchImage = createRestrictedFetcher(seamsFor({
      onRequest: async () => ({
        statusCode: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: chunked(Buffer.from('<html>not an image</html>')),
      }),
    }));
    const result = await fetchImage('https://origin.example/x.png');
    expect(result.outcome).toBe('not_image');
  });

  it('rejects image Content-Type with non-image magic bytes', async () => {
    const fetchImage = createRestrictedFetcher(seamsFor({
      onRequest: async () => ok(Buffer.from('this is plain text pretending'), 'image/png'),
    }));
    const result = await fetchImage('https://origin.example/x.png');
    expect(result.outcome).toBe('magic_mismatch');
  });

  it('rejects when the declared subtype disagrees with the magic bytes', async () => {
    const fetchImage = createRestrictedFetcher(seamsFor({
      onRequest: async () => ok(jpegBytes(), 'image/png'),
    }));
    const result = await fetchImage('https://origin.example/x.png');
    expect(result.outcome).toBe('magic_mismatch');
  });

  it('aborts a body that exceeds the cap instead of buffering it', async () => {
    const big = Buffer.concat([pngBytes(), Buffer.alloc(5000, 7)]);
    const fetchImage = createRestrictedFetcher(seamsFor({
      onRequest: async () => ok(big, 'image/png'),
    }));
    const result = await fetchImage('https://origin.example/x.png', { maxBytes: 1024 });
    expect(result.outcome).toBe('too_large');
    expect(FETCH_MAX_BYTES).toBe(10 * 1024 * 1024);
  });

  it('maps a refused connection to unreachable', async () => {
    const fetchImage = createRestrictedFetcher({
      resolve: async () => ['93.184.216.34'],
      transport: async () => {
        const err = new Error('connect ECONNREFUSED') as NodeJS.ErrnoException;
        err.code = 'ECONNREFUSED';
        throw err;
      },
    });
    const result = await fetchImage('https://origin.example/x.png');
    expect(result.outcome).toBe('unreachable');
  });

  it('maps an HTTP error status to unreachable', async () => {
    const fetchImage = createRestrictedFetcher(seamsFor({
      onRequest: async () => ({ statusCode: 404, headers: {}, body: chunked(Buffer.alloc(0)) }),
    }));
    const result = await fetchImage('https://origin.example/missing.png');
    expect(result.outcome).toBe('unreachable');
  });

  it('maps a stalled body read to timeout', async () => {
    const hanging: AsyncIterable<Buffer> = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise(() => undefined),
      }),
    };
    const fetchImage = createRestrictedFetcher(seamsFor({
      onRequest: async () => ({ statusCode: 200, headers: { 'content-type': 'image/png' }, body: hanging }),
    }));
    const result = await fetchImage('https://origin.example/x.png', { totalTimeoutMs: 60 });
    expect(result.outcome).toBe('timeout');
  });

  it('propagates URL-shape refusals as FetchRefusedError (no fetch recorded)', async () => {
    const fetchImage = createRestrictedFetcher(seamsFor({ onRequest: async () => ok(pngBytes(), 'image/png') }));
    await expect(fetchImage('https://user:pass@origin.example/x.png')).rejects.toThrow(FetchRefusedError);
    await expect(fetchImage('gopher://origin.example/x.png')).rejects.toThrow(FetchRefusedError);
  });
});

// --- Success cases -----------------------------------------------------

describe('restricted fetcher: success cases', () => {
  const cases: Array<[string, Buffer, string, number | null, number | null]> = [
    ['png', pngBytes(640, 480), 'image/png', 640, 480],
    ['jpeg', jpegBytes(320, 200), 'image/jpeg', 320, 200],
    ['gif', gifBytes(16, 16), 'image/gif', 16, 16],
    ['webp', webpBytes(1024, 768), 'image/webp', 1024, 768],
    ['avif', avifBytes(), 'image/avif', null, null],
  ];
  it.each(cases)('fetches and verifies a %s image', async (_name, bytes, type, width, height) => {
    const fetchImage = createRestrictedFetcher(seamsFor({
      onRequest: async () => ok(bytes, type),
    }));
    const result = await fetchImage('https://origin.example/img');
    expect(result.outcome).toBe('success');
    if (result.outcome !== 'success') return;
    expect(result.image.contentType).toBe(type);
    expect(result.image.width).toBe(width);
    expect(result.image.height).toBe(height);
    expect(result.image.bytes.equals(bytes)).toBe(true);
    expect(result.image.sha256).toBe(crypto.createHash('sha256').update(bytes).digest('hex'));
  });

  it('follows a same-scheme redirect and reports the final URL', async () => {
    const fetchImage = createRestrictedFetcher(seamsFor({
      onRequest: scriptedTransport((url) => {
        if (url.pathname === '/old.png') return redirectTo('https://origin.example/new.png');
        return ok(pngBytes(), 'image/png');
      }),
    }));
    const result = await fetchImage('https://origin.example/old.png');
    expect(result.outcome).toBe('success');
    if (result.outcome !== 'success') return;
    expect(result.image.finalUrl).toBe('https://origin.example/new.png');
    expect(result.image.redirects).toBe(1);
  });
});

// --- Format helpers ----------------------------------------------------

describe('sniffImageFormat and imageDimensions', () => {
  it('sniffs each supported format and rejects text', () => {
    expect(sniffImageFormat(pngBytes())).toBe('png');
    expect(sniffImageFormat(jpegBytes())).toBe('jpeg');
    expect(sniffImageFormat(gifBytes())).toBe('gif');
    expect(sniffImageFormat(webpBytes())).toBe('webp');
    expect(sniffImageFormat(avifBytes())).toBe('avif');
    expect(sniffImageFormat(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
  });
  it('extracts PNG and JPEG dimensions and reports AVIF as null', () => {
    expect(imageDimensions('png', pngBytes(11, 22))).toEqual({ width: 11, height: 22 });
    expect(imageDimensions('jpeg', jpegBytes(33, 44))).toEqual({ width: 33, height: 44 });
    expect(imageDimensions('avif', avifBytes())).toEqual({ width: null, height: null });
  });
});
