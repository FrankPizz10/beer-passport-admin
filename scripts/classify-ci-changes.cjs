// Unknown paths run backend checks; shared CI configuration runs both.
const { execFileSync } = require('child_process');
const isFrontend = p => /^(src\/|public\/|package\.json$|package-lock\.json$|tsconfig\.json$|\.env\.example$|\.nvmrc$|netlify\.toml$)/.test(p);
const isShared = p => /^(\.github\/workflows\/|scripts\/classify-ci-changes\.cjs$)/.test(p);
function classify(base, head) {
  const names = execFileSync('git', ['diff', '--name-only', '-z', base, head], { encoding: 'utf8' }).split('\0').filter(Boolean);
  return { frontend: names.some(p => isFrontend(p) || isShared(p)), backend: names.some(p => !isFrontend(p) || isShared(p)) };
}
try {
  if (process.argv[2] === '--backend-unchanged') {
    process.exit(classify(process.argv[3], process.argv[4]).backend ? 1 : 0);
  }
  const base = process.env.EVENT_NAME === 'pull_request' ? process.env.PR_BASE : process.env.BEFORE;
  const all = process.env.EVENT_NAME === 'workflow_dispatch' || !base || /^0+$/.test(base);
  const result = all ? { frontend: true, backend: true } : classify(base, process.env.GITHUB_SHA || 'HEAD');
  console.log(`frontend=${result.frontend}\nbackend=${result.backend}`);
} catch (error) {
  if (process.argv[2] === '--backend-unchanged') { console.error(error.message); process.exit(1); }
  console.error(`Unable to classify changes; running both: ${error.message}`);
  console.log('frontend=true\nbackend=true');
}
