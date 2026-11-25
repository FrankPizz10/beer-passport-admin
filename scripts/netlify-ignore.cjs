// Netlify cancels when this command exits 0. Fail open when history is absent.
const { execFileSync } = require('child_process');
const base = process.env.CACHED_COMMIT_REF;
const head = process.env.COMMIT_REF;
if (!base || !head) process.exit(1);
try {
  const paths = execFileSync('git', ['diff', '--name-only', '-z', base, head], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const relevant = paths.some(p => /^(src\/|public\/|package\.json$|package-lock\.json$|tsconfig\.json$|\.env\.example$|\.nvmrc$|netlify\.toml$|scripts\/netlify-ignore\.cjs$)/.test(p));
  process.exit(relevant ? 1 : 0);
} catch (e) { console.error(`Cannot compare Netlify commits: ${e.message}`); process.exit(1); }
