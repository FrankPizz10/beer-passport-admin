// Restricted server-side image fetcher for the discovery hub (hub
// decision 006 revision 2, issues/001 section 4). The reviewer never
// views a candidate image at its origin URL: this module fetches the
// staged locator server-side, under the documented SSRF restrictions,
// and the caller stores the returned bytes content-addressed and
// serves the preview from those bytes, so the bytes a decision binds
// to (by SHA-256) are the exact bytes that were displayed.
//
// Restrictions enforced here, each with a dedicated failure outcome:
//   - http/https only, no credentials embedded in the URL. URL-shape
//     refusals are NOT fetch attempts: parseFetchUrl throws
//     FetchRefusedError before any network activity and the route
//     answers 422 without writing a fetches row.
//   - DNS results are rejected when ANY resolved address is private,
//     loopback, link-local, or reserved (isBlockedAddress: IPv4
//     0.0.0.0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12,
//     192.0.0/24, 192.0.2/24, 192.168/16, 198.18/15, 198.51.100/24,
//     203.0.113/24, 224/4, 240/4; IPv6 ::, ::1, 64:ff9b::/96,
//     100::/64, 2001:db8::/32, fc00::/7, fe80::/10, ff00::/8, and
//     IPv4-mapped ::ffff:a.b.c.d judged by the embedded IPv4). The
//     check runs at EVERY redirect hop, and the transport connects to
//     the exact validated address (a pinned DNS lookup), so a
//     rebinding between validation and connect has no window.
//     Outcome: dns_blocked.
//   - At most 3 redirects (a 4th redirect response is refused:
//     redirect_blocked); an https -> http downgrade redirect is
//     refused (downgrade_blocked); a redirect to a URL with embedded
//     credentials or a non-http(s) scheme is redirect_blocked.
//   - Connect timeout 5s (socket timeout before the response), total
//     timeout 10s (one deadline across all hops and the body):
//     timeout.
//   - Response body capped at 10 MB, streamed: the read aborts as
//     soon as the cap is exceeded rather than buffering unboundedly:
//     too_large.
//   - The final Content-Type must be image/* (else not_image) AND the
//     magic bytes must verify as jpeg, png, webp, gif, or avif and
//     agree with the declared subtype (else magic_mismatch). The
//     verified content type reported is the one derived from the
//     magic bytes, never the origin's claim.
//
// DNS resolution and the HTTP transport sit behind injectable seams
// (FetchSeams) so the whole battery is unit-testable without network;
// production uses defaultSeams. Tests may substitute the address
// validator ONLY through the seams object (the integration suite
// points the fetcher at a loopback stub origin that way); the routes
// always build the fetcher with defaultSeams.
//
// NOTE for readOnlyGuard.test.ts: this module is on the mutation
// allowlist only because crypto's Hash.update( trips the guard's
// text search. It contains no Prisma call of any kind.
import * as crypto from 'crypto';
import * as dns from 'dns';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';

export const FETCH_MAX_REDIRECTS = 3;
export const FETCH_MAX_BYTES = 10 * 1024 * 1024;
export const FETCH_CONNECT_TIMEOUT_MS = 5000;
export const FETCH_TOTAL_TIMEOUT_MS = 10000;

export type FetchFailureOutcome =
  | 'dns_blocked'
  | 'redirect_blocked'
  | 'downgrade_blocked'
  | 'too_large'
  | 'not_image'
  | 'magic_mismatch'
  | 'unreachable'
  | 'timeout';

export interface FetchedImage {
  bytes: Buffer;
  sha256: string;
  // The verified content type, derived from the magic bytes.
  contentType: string;
  width: number | null;
  height: number | null;
  finalUrl: string;
  redirects: number;
}

export type FetchResult =
  | { outcome: 'success'; image: FetchedImage }
  | { outcome: FetchFailureOutcome; detail: string };

// Thrown for URL-shape refusals (unparseable, non-http(s) scheme,
// embedded credentials). These happen before any fetch attempt: the
// route maps them to 422 and no fetches row is written.
export class FetchRefusedError extends Error {}

export const sha256Hex = (bytes: Buffer): string =>
  crypto.createHash('sha256').update(bytes).digest('hex');

// ---------------------------------------------------------------------
// Address validation
// ---------------------------------------------------------------------

const ipv4ToInt = (ip: string): number | null => {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value >>> 0;
};

const ipv4In = (value: number, base: string, prefixBits: number): boolean => {
  const baseValue = ipv4ToInt(base);
  if (baseValue === null) return false;
  const mask = prefixBits === 0 ? 0 : (0xffffffff << (32 - prefixBits)) >>> 0;
  return (value & mask) === (baseValue & mask);
};

const IPV4_BLOCKED_RANGES: Array<[string, number, string]> = [
  ['0.0.0.0', 8, 'unspecified / this-network'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'shared address space (CGNAT)'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'protocol assignments'],
  ['192.0.2.0', 24, 'documentation (TEST-NET-1)'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'documentation (TEST-NET-2)'],
  ['203.0.113.0', 24, 'documentation (TEST-NET-3)'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
];

export const blockedIpv4Reason = (ip: string): string | null => {
  const value = ipv4ToInt(ip);
  if (value === null) return 'unparseable address';
  for (const [base, prefix, label] of IPV4_BLOCKED_RANGES) {
    if (ipv4In(value, base, prefix)) return `${label} range ${base}/${prefix}`;
  }
  return null;
};

// Expand an IPv6 literal to its 8 hextets, or null when unparseable.
// Handles :: compression and an embedded IPv4 tail.
const parseIpv6 = (ip: string): number[] | null => {
  let rest = ip.toLowerCase();
  const v4Tail = rest.match(/(\d+\.\d+\.\d+\.\d+)$/);
  let tailHextets: number[] = [];
  if (v4Tail) {
    const v4 = ipv4ToInt(v4Tail[1]);
    if (v4 === null) return null;
    tailHextets = [(v4 >>> 16) & 0xffff, v4 & 0xffff];
    rest = rest.slice(0, rest.length - v4Tail[1].length);
    if (rest.endsWith(':')) rest = rest.slice(0, -1);
    // The embedded form is '::ffff:1.2.3.4' or '::1.2.3.4': after
    // removing the tail, a trailing single ':' belonged to the tail.
  }
  const halves = rest.split('::');
  if (halves.length > 2) return null;
  const parseSide = (side: string): number[] | null => {
    if (side === '') return [];
    const out: number[] = [];
    for (const part of side.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      out.push(parseInt(part, 16));
    }
    return out;
  };
  const left = parseSide(halves[0]);
  if (left === null) return null;
  if (halves.length === 1) {
    const all = [...left, ...tailHextets];
    return all.length === 8 ? all : null;
  }
  const right = parseSide(halves[1]);
  if (right === null) return null;
  const middle = 8 - left.length - right.length - tailHextets.length;
  if (middle < 0) return null;
  return [...left, ...new Array(middle).fill(0), ...right, ...tailHextets];
};

export const blockedIpv6Reason = (ip: string): string | null => {
  const h = parseIpv6(ip);
  if (h === null) return 'unparseable address';
  // IPv4-mapped (::ffff:a.b.c.d): judge by the embedded IPv4 address.
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff) {
    const v4 = `${(h[6] >>> 8) & 0xff}.${h[6] & 0xff}.${(h[7] >>> 8) & 0xff}.${h[7] & 0xff}`;
    const reason = blockedIpv4Reason(v4);
    return reason ? `IPv4-mapped ${reason}` : null;
  }
  if (h.every((x) => x === 0)) return 'unspecified address ::';
  if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return 'loopback ::1';
  if ((h[0] & 0xffc0) === 0xfe80) return 'link-local fe80::/10';
  if ((h[0] & 0xfe00) === 0xfc00) return 'unique local fc00::/7';
  if ((h[0] & 0xff00) === 0xff00) return 'multicast ff00::/8';
  if (h[0] === 0x0100 && h[1] === 0 && h[2] === 0 && h[3] === 0) return 'discard 100::/64';
  if (h[0] === 0x2001 && h[1] === 0x0db8) return 'documentation 2001:db8::/32';
  if (h[0] === 0x0064 && h[1] === 0xff9b) return 'NAT64 well-known prefix 64:ff9b::/96';
  return null;
};

// Returns a human-readable reason when the address must not be
// connected to, or null when it is a public address.
export const blockedAddressReason = (address: string): string | null => {
  const family = net.isIP(address);
  if (family === 4) return blockedIpv4Reason(address);
  if (family === 6) return blockedIpv6Reason(address);
  return 'unparseable address';
};

export const isBlockedAddress = (address: string): boolean =>
  blockedAddressReason(address) !== null;

// ---------------------------------------------------------------------
// URL shape
// ---------------------------------------------------------------------

export const parseFetchUrl = (raw: string): URL => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchRefusedError('The staged image reference is not a parseable URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FetchRefusedError(
      `The staged image reference uses scheme '${url.protocol}'; only http and https can be fetched.`,
    );
  }
  if (url.username || url.password) {
    throw new FetchRefusedError('The staged image reference embeds credentials; credentialed URLs are refused.');
  }
  if (!url.hostname) {
    throw new FetchRefusedError('The staged image reference has no host.');
  }
  return url;
};

// ---------------------------------------------------------------------
// Magic bytes and dimensions
// ---------------------------------------------------------------------

const FORMAT_CONTENT_TYPES: Record<string, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
};

export const sniffImageFormat = (bytes: Buffer): string | null => {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return 'png';
  if (bytes.length >= 6) {
    const head = bytes.subarray(0, 6).toString('ascii');
    if (head === 'GIF87a' || head === 'GIF89a') return 'gif';
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) return 'webp';
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = bytes.subarray(8, 12).toString('ascii');
    if (brand === 'avif' || brand === 'avis' || brand === 'avifs') return 'avif';
  }
  return null;
};

// Dimensions are extracted only where the format carries them in a
// fixed header location cheaply and unambiguously: PNG (IHDR), GIF
// (logical screen descriptor), JPEG (first SOF segment), WebP (VP8X /
// VP8 / VP8L chunk headers). AVIF dimensions live inside nested ISOBMFF
// boxes and are reported as null rather than guessed.
export const imageDimensions = (
  format: string,
  bytes: Buffer,
): { width: number | null; height: number | null } => {
  const none = { width: null, height: null };
  try {
    if (format === 'png' && bytes.length >= 24) {
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    if (format === 'gif' && bytes.length >= 10) {
      return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
    }
    if (format === 'jpeg') {
      let offset = 2;
      while (offset + 4 <= bytes.length) {
        if (bytes[offset] !== 0xff) return none;
        const marker = bytes[offset + 1];
        // Standalone markers (TEM, RSTn, SOI, EOI) carry no length.
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
          offset += 2;
          continue;
        }
        const length = bytes.readUInt16BE(offset + 2);
        if (length < 2) return none;
        const isSof =
          marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSof && offset + 9 <= bytes.length) {
          return {
            height: bytes.readUInt16BE(offset + 5),
            width: bytes.readUInt16BE(offset + 7),
          };
        }
        offset += 2 + length;
      }
      return none;
    }
    if (format === 'webp' && bytes.length >= 30) {
      const chunk = bytes.subarray(12, 16).toString('ascii');
      if (chunk === 'VP8X') {
        return {
          width: (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)) + 1,
          height: (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) + 1,
        };
      }
      if (chunk === 'VP8 ' && bytes.length >= 30) {
        return {
          width: bytes.readUInt16LE(26) & 0x3fff,
          height: bytes.readUInt16LE(28) & 0x3fff,
        };
      }
      if (chunk === 'VP8L' && bytes.length >= 25) {
        const b1 = bytes[21];
        const b2 = bytes[22];
        const b3 = bytes[23];
        const b4 = bytes[24];
        return {
          width: (b1 | ((b2 & 0x3f) << 8)) + 1,
          height: ((b2 >>> 6) | (b3 << 2) | ((b4 & 0x03) << 10)) + 1,
        };
      }
      return none;
    }
    return none;
  } catch {
    return none;
  }
};

// ---------------------------------------------------------------------
// Seams (DNS + transport) and the default implementations
// ---------------------------------------------------------------------

export interface TransportResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Buffer>;
}

export interface FetchSeams {
  resolve: (hostname: string) => Promise<string[]>;
  transport: (args: {
    url: URL;
    address: string;
    connectTimeoutMs: number;
    signal: AbortSignal;
  }) => Promise<TransportResponse>;
  // Injectable ONLY so tests can point the fetcher at a loopback stub
  // origin; production always uses blockedAddressReason.
  blockedReason?: (address: string) => string | null;
}

const defaultResolve = async (hostname: string): Promise<string[]> => {
  const records = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
};

const defaultTransport = (args: {
  url: URL;
  address: string;
  connectTimeoutMs: number;
  signal: AbortSignal;
}): Promise<TransportResponse> =>
  new Promise((resolvePromise, rejectPromise) => {
    const { url, address, connectTimeoutMs, signal } = args;
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const family = net.isIP(address);
    const request = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port ? Number(url.port) : isHttps ? 443 : 80,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        // The fetch is already pinned to one address that we resolved
        // and validated. Node 20+ enables autoSelectFamily by default;
        // that mode calls custom lookup with `all: true` and expects an
        // address array, while this callback deliberately returns the
        // single validated address. Keep the scalar lookup contract so
        // Node cannot re-resolve or try any unvalidated address.
        autoSelectFamily: false,
        headers: {
          'User-Agent': 'BeerPassportAdmin/1.0 (discovery image fetch)',
          Accept: 'image/*',
        },
        // Pin the connection to the exact address that was validated:
        // the lookup callback answers with it for every family, so DNS
        // is never consulted a second time inside the connect.
        lookup: (_hostname: string, _options: unknown, callback: (err: NodeJS.ErrnoException | null, addr: string, fam: number) => void) => {
          callback(null, address, family);
        },
        timeout: connectTimeoutMs,
        signal,
        agent: false,
      } as http.RequestOptions,
      (response) => {
        resolvePromise({
          statusCode: response.statusCode || 0,
          headers: response.headers as Record<string, string | string[] | undefined>,
          body: response as unknown as AsyncIterable<Buffer>,
        });
      },
    );
    request.on('timeout', () => {
      request.destroy(new Error(`connect/socket timeout after ${connectTimeoutMs}ms`));
    });
    request.on('error', rejectPromise);
    request.end();
  });

export const defaultSeams: FetchSeams = {
  resolve: defaultResolve,
  transport: defaultTransport,
  blockedReason: blockedAddressReason,
};

// ---------------------------------------------------------------------
// The fetcher
// ---------------------------------------------------------------------

export interface FetchOptions {
  maxRedirects?: number;
  maxBytes?: number;
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
}

const headerValue = (
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null => {
  const raw = headers[name];
  if (Array.isArray(raw)) return raw.length > 0 ? raw[0] : null;
  return typeof raw === 'string' ? raw : null;
};

const readBody = async (
  body: AsyncIterable<Buffer>,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ bytes: Buffer } | { tooLarge: true }> => {
  const chunks: Buffer[] = [];
  let total = 0;
  const iterator = body[Symbol.asyncIterator]();
  for (;;) {
    if (signal.aborted) throw new Error('fetch aborted');
    const next = await Promise.race([
      iterator.next(),
      new Promise<never>((_resolve, reject) => {
        if (signal.aborted) reject(new Error('fetch aborted'));
        else signal.addEventListener('abort', () => reject(new Error('fetch aborted')), { once: true });
      }),
    ]);
    if (next.done) break;
    const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value as Uint8Array);
    total += chunk.length;
    if (total > maxBytes) {
      if (typeof (iterator as any).return === 'function') {
        await (iterator as any).return().catch(() => undefined);
      }
      return { tooLarge: true };
    }
    chunks.push(chunk);
  }
  return { bytes: Buffer.concat(chunks) };
};

const isTimeoutError = (err: unknown): boolean => {
  const e = err as NodeJS.ErrnoException;
  return e && (e.code === 'ETIMEDOUT' || /timeout/i.test(e.message || ''));
};

export const createRestrictedFetcher = (seams: FetchSeams) => {
  const blockedReason = seams.blockedReason || blockedAddressReason;

  const fetchImage = async (rawUrl: string, options: FetchOptions = {}): Promise<FetchResult> => {
    const maxRedirects = options.maxRedirects ?? FETCH_MAX_REDIRECTS;
    const maxBytes = options.maxBytes ?? FETCH_MAX_BYTES;
    const connectTimeoutMs = options.connectTimeoutMs ?? FETCH_CONNECT_TIMEOUT_MS;
    const totalTimeoutMs = options.totalTimeoutMs ?? FETCH_TOTAL_TIMEOUT_MS;

    // Shape refusals throw (the caller maps them to 422 pre-fetch).
    let current = parseFetchUrl(rawUrl);

    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), totalTimeoutMs);
    try {
      let redirects = 0;
      for (;;) {
        // Resolve and validate EVERY hop, redirects included. (URL
        // keeps the brackets on an IPv6 literal hostname; strip them
        // before the isIP check.)
        const hostname = current.hostname.replace(/^\[|\]$/g, '');
        let addresses: string[];
        if (net.isIP(hostname)) {
          addresses = [hostname];
        } else {
          try {
            addresses = await seams.resolve(hostname);
          } catch (err) {
            if (controller.signal.aborted) return { outcome: 'timeout', detail: `Fetch exceeded the ${totalTimeoutMs}ms total timeout.` };
            return { outcome: 'unreachable', detail: `DNS resolution failed for ${hostname}: ${(err as Error).message}` };
          }
          if (!addresses || addresses.length === 0) {
            return { outcome: 'unreachable', detail: `DNS resolution returned no addresses for ${hostname}.` };
          }
        }
        for (const address of addresses) {
          const reason = blockedReason(address);
          if (reason) {
            return {
              outcome: 'dns_blocked',
              detail: `Address ${address} for ${hostname} is blocked: ${reason}.`,
            };
          }
        }

        let response: TransportResponse;
        try {
          response = await seams.transport({
            url: current,
            address: addresses[0],
            connectTimeoutMs,
            signal: controller.signal,
          });
        } catch (err) {
          if (controller.signal.aborted || isTimeoutError(err)) {
            return { outcome: 'timeout', detail: `Fetch to ${hostname} timed out (connect ${connectTimeoutMs}ms, total ${totalTimeoutMs}ms).` };
          }
          return { outcome: 'unreachable', detail: `Fetch to ${hostname} failed: ${(err as Error).message}` };
        }

        const status = response.statusCode;
        if (status >= 300 && status < 400) {
          const location = headerValue(response.headers, 'location');
          if (!location) {
            return { outcome: 'unreachable', detail: `HTTP ${status} without a Location header from ${current.toString()}.` };
          }
          if (redirects >= maxRedirects) {
            return { outcome: 'redirect_blocked', detail: `More than ${maxRedirects} redirects (refused at ${current.toString()}).` };
          }
          let next: URL;
          try {
            next = new URL(location, current);
          } catch {
            return { outcome: 'redirect_blocked', detail: `Unparseable redirect Location '${location}'.` };
          }
          if ((next.protocol !== 'http:' && next.protocol !== 'https:') || next.username || next.password) {
            return { outcome: 'redirect_blocked', detail: `Redirect to a refused URL shape at ${next.toString()}.` };
          }
          if (current.protocol === 'https:' && next.protocol === 'http:') {
            return { outcome: 'downgrade_blocked', detail: `Refused https -> http downgrade redirect to ${next.toString()}.` };
          }
          redirects += 1;
          current = next;
          continue;
        }

        if (status < 200 || status >= 300) {
          return { outcome: 'unreachable', detail: `HTTP ${status} from ${current.toString()}.` };
        }

        const declaredRaw = headerValue(response.headers, 'content-type');
        const declared = declaredRaw ? declaredRaw.split(';')[0].trim().toLowerCase() : '';
        if (!declared.startsWith('image/')) {
          return {
            outcome: 'not_image',
            detail: `Final Content-Type '${declared || '(none)'}' is not image/*.`,
          };
        }

        let read: { bytes: Buffer } | { tooLarge: true };
        try {
          read = await readBody(response.body, maxBytes, controller.signal);
        } catch (err) {
          if (controller.signal.aborted) {
            return { outcome: 'timeout', detail: `Fetch exceeded the ${totalTimeoutMs}ms total timeout while reading the body.` };
          }
          return { outcome: 'unreachable', detail: `Reading the response body failed: ${(err as Error).message}` };
        }
        if ('tooLarge' in read) {
          return { outcome: 'too_large', detail: `Response body exceeded the ${maxBytes}-byte cap; the read was aborted.` };
        }

        const bytes = read.bytes;
        const format = sniffImageFormat(bytes);
        if (!format) {
          return { outcome: 'magic_mismatch', detail: 'The body bytes do not match any known image format (jpeg, png, webp, gif, avif).' };
        }
        const verifiedType = FORMAT_CONTENT_TYPES[format];
        if (declared !== verifiedType) {
          return {
            outcome: 'magic_mismatch',
            detail: `Declared Content-Type '${declared}' does not match the magic bytes (${verifiedType}).`,
          };
        }
        const { width, height } = imageDimensions(format, bytes);
        return {
          outcome: 'success',
          image: {
            bytes,
            sha256: sha256Hex(bytes),
            contentType: verifiedType,
            width,
            height,
            finalUrl: current.toString(),
            redirects,
          },
        };
      }
    } finally {
      clearTimeout(deadline);
    }
  };

  return fetchImage;
};

export const fetchImageRestricted = createRestrictedFetcher(defaultSeams);
