// Operator tool: build an immutable discovery bundle from one staged
// results file (hub decision 006, issues/001-catalog-discovery-hub.md).
//
//   npx ts-node --transpile-only scripts/build-discovery-bundle.ts \
//     --in <staged.json> --slug <batch-slug> --source <source-label> \
//     --out <bundle-root> [--title <title>] [--source-summary <text>] \
//     [--limit N]
//
// Writes <bundle-root>/<slug>/manifest.json and
// <bundle-root>/<slug>/candidates.jsonl (one canonical JSON candidate
// per line, keys sorted). The mapping, hold derivation, and pair
// extraction rules live in discoveryBundleCore.ts and are unit-tested
// there. Bundles are transport artifacts: they are never committed to
// git and never written to the Lightsail host; the ingest script
// (ingest-discovery-bundle.ts) loads them from wherever the operator
// runs it.
//
// --limit N builds a small seed bundle from the first N staged records
// for end-to-end review before the full batch is ingested.
//
// Prints a JSON summary: { slug, records, holds_by_reason, pairs,
// candidates_sha256, bundle_dir }.
import * as fs from 'fs';
import * as path from 'path';
import { buildBundleData, canonicalStringify, StagedRecord } from './discoveryBundleCore';

const argValue = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};

const main = () => {
  const args = process.argv.slice(2);
  const inFile = argValue(args, '--in');
  const slug = argValue(args, '--slug');
  const source = argValue(args, '--source');
  const outRoot = argValue(args, '--out');
  const limitRaw = argValue(args, '--limit');
  if (!inFile || !slug || !source || !outRoot) {
    console.error('Usage: build-discovery-bundle.ts --in <staged.json> --slug <slug> --source <label> --out <bundle-root> [--title <t>] [--source-summary <s>] [--limit N]');
    process.exit(2);
  }
  const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    console.error('REFUSING TO BUILD: --limit must be a positive integer.');
    process.exit(2);
  }
  const parsed = JSON.parse(fs.readFileSync(inFile, 'utf8'));
  if (!Array.isArray(parsed)) {
    console.error('REFUSING TO BUILD: the staged file must contain a JSON array of records.');
    process.exit(2);
  }
  const built = buildBundleData(parsed as StagedRecord[], {
    slug,
    source,
    title: argValue(args, '--title'),
    sourceSummary: argValue(args, '--source-summary'),
    limit,
  });
  const bundleDir = path.join(outRoot, slug);
  fs.mkdirSync(bundleDir, { recursive: true });
  fs.writeFileSync(path.join(bundleDir, 'candidates.jsonl'), built.jsonl);
  fs.writeFileSync(path.join(bundleDir, 'manifest.json'), canonicalStringify(built.manifest) + '\n');
  console.log(JSON.stringify({
    slug,
    records: built.summary.records,
    holds_by_reason: built.summary.holds_by_reason,
    pairs: built.summary.pairs,
    candidates_sha256: built.manifest.candidates_sha256,
    bundle_dir: bundleDir,
  }, null, 2));
};

if (require.main === module) {
  main();
}
