import * as fs from 'fs';
import * as path from 'path';

const banned = ['.create(', '.createMany(', '.update(', '.updateMany(', '.delete(', '.deleteMany(', '.upsert(', '$executeRaw', '$executeRawUnsafe'];

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
  it('no server source file uses a Prisma mutation call', () => {
    const files = collect(__dirname);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const needle of banned) {
        expect({ file, needle, found: text.includes(needle) }).toEqual({ file, needle, found: false });
      }
    }
  });
});
