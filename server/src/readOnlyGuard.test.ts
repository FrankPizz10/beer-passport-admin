import * as fs from 'fs';
import * as path from 'path';

// The viewer is read-only by construction, with exactly one scoped
// exception: the image approval workflow's write path. Prisma mutation
// methods may appear ONLY in these two modules:
//   - src/writeDb.ts                builds the approver Prisma client
//   - src/routes/imageApprovals.ts  the POST approve/reject handlers
// Every other server source file must contain no mutation call at all.
// Widening this list is a deliberate, reviewed act: edit this test in
// the same change and justify it in review. (Operator scripts under
// server/scripts/ are outside src/ and outside this guard, as before.)
const banned = ['.create(', '.createMany(', '.update(', '.updateMany(', '.delete(', '.deleteMany(', '.upsert(', '$executeRaw', '$executeRawUnsafe'];

const MUTATION_ALLOWED_FILES = new Set([
  path.join(__dirname, 'writeDb.ts'),
  path.join(__dirname, 'routes', 'imageApprovals.ts'),
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
  it('the mutation exception is exactly the two write-path modules, and they exist', () => {
    expect(MUTATION_ALLOWED_FILES.size).toBe(2);
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

  it('the approval route module is the only route module with mutation calls', () => {
    const routesDir = path.join(__dirname, 'routes');
    for (const file of collect(routesDir)) {
      const text = fs.readFileSync(file, 'utf8');
      const found = banned.filter((needle) => text.includes(needle));
      if (file === path.join(routesDir, 'imageApprovals.ts')) {
        expect(found.length).toBeGreaterThan(0);
      } else {
        expect({ file, found }).toEqual({ file, found: [] });
      }
    }
  });
});
