import * as fs from 'fs';
import * as path from 'path';

// The viewer is read-only by construction, with exactly two scoped
// exceptions: the image approval workflow's write path and the
// discovery hub's decision write path. Prisma mutation methods may
// appear ONLY in these four modules:
//   - src/writeDb.ts                    builds the approver Prisma client
//   - src/routes/imageApprovals.ts      the POST approve/reject handlers
//   - src/discoveryWriteDb.ts           builds the discovery reviewer
//                                       Prisma client
//   - src/routes/discoveryDecisions.ts  the POST discovery decide
//                                       handlers (candidate-selection
//                                       gate only; decision 006)
// Every other server source file must contain no mutation call at all.
// Widening this list is a deliberate, reviewed act: edit this test in
// the same change and justify it in review. (Operator scripts under
// server/scripts/ are outside src/ and outside this guard, as before.)
const banned = ['.create(', '.createMany(', '.update(', '.updateMany(', '.delete(', '.deleteMany(', '.upsert(', '$executeRaw', '$executeRawUnsafe'];

const MUTATION_ALLOWED_FILES = new Set([
  path.join(__dirname, 'writeDb.ts'),
  path.join(__dirname, 'routes', 'imageApprovals.ts'),
  path.join(__dirname, 'discoveryWriteDb.ts'),
  path.join(__dirname, 'routes', 'discoveryDecisions.ts'),
]);

const collect = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
};

describe('read only guard', () => {
  it('the mutation exception is exactly the four write-path modules, and they exist', () => {
    expect(MUTATION_ALLOWED_FILES.size).toBe(4);
    for (const file of MUTATION_ALLOWED_FILES) {
      expect(fs.existsSync(file)).toBe(true);
    }
  });

  it('no server source file outside the write path uses a Prisma mutation call', () => {
    const files = collect(__dirname);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      if (MUTATION_ALLOWED_FILES.has(file)) continue;
      const text = fs.readFileSync(file, 'utf8');
      for (const needle of banned) {
        expect({ file, needle, found: text.includes(needle) }).toEqual({ file, needle, found: false });
      }
    }
  });

  it('the approval and discovery-decision route modules are the only route modules with mutation calls', () => {
    const routesDir = path.join(__dirname, 'routes');
    const mutationRoutes = new Set([
      path.join(routesDir, 'imageApprovals.ts'),
      path.join(routesDir, 'discoveryDecisions.ts'),
    ]);
    for (const file of collect(routesDir)) {
      const text = fs.readFileSync(file, 'utf8');
      const found = banned.filter((needle) => text.includes(needle));
      if (mutationRoutes.has(file)) {
        expect(found.length).toBeGreaterThan(0);
      } else {
        expect({ file, found }).toEqual({ file, found: [] });
      }
    }
  });
});
