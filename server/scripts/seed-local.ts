// Synthetic local seed for the admin viewer. This script is the ONLY file
// in this server allowed to use Prisma mutation methods; the server source
// under src/ is read only (enforced by src/readOnlyGuard.test.ts).
// HARD REFUSAL: the script exits non-zero unless the DATABASE_URL hostname
// is localhost or 127.0.0.1. It never seeds a remote database.
// Idempotent: it first removes the rows it owns, then inserts fresh ones.
import dotenv from 'dotenv';
dotenv.config();
import { PrismaClient } from '@prisma/client';

const main = async () => {
  const raw = process.env.DATABASE_URL || '';
  let host = '';
  try { host = new URL(raw).hostname; } catch { host = ''; }
  if (host !== 'localhost' && host !== '127.0.0.1') {
    console.error('REFUSING TO SEED: DATABASE_URL hostname must be localhost or 127.0.0.1, got: ' + (host || '(unparseable)'));
    process.exit(1);
  }
  const prisma = new PrismaClient();
  try {
    // Clean up rows owned by this seed.
    const owned = await prisma.users.findMany({ where: { email: { endsWith: '@example.com' } }, select: { id: true } });
    const ownedIds = owned.map((u) => u.id);
    if (ownedIds.length > 0) {
      await prisma.notifications.deleteMany({ where: { user_id: { in: ownedIds } } });
      await prisma.user_badges.deleteMany({ where: { user_id: { in: ownedIds } } });
      await prisma.user_beers.deleteMany({ where: { user_id: { in: ownedIds } } });
      await prisma.friends.deleteMany({ where: { OR: [{ user_1: { in: ownedIds } }, { user_2: { in: ownedIds } }] } });
    }
    const oldCollection = await prisma.collections.findFirst({ where: { name: 'Local Test Collection' }, select: { id: true } });
    if (oldCollection) {
      await prisma.user_badges.deleteMany({ where: { collection_id: oldCollection.id } });
      await prisma.collection_beers.deleteMany({ where: { collection_id: oldCollection.id } });
      await prisma.collections.delete({ where: { id: oldCollection.id } });
    }
    if (ownedIds.length > 0) {
      await prisma.users.deleteMany({ where: { id: { in: ownedIds } } });
    }
    await prisma.api_keys.deleteMany({ where: { name: { startsWith: 'local-test' } } });

    const beers = await prisma.beers.findMany({ select: { id: true }, orderBy: { id: 'asc' }, take: 3 });
    if (beers.length < 3) {
      console.error('Seed needs at least 3 catalog beers in the database.');
      process.exit(1);
    }

    const admin = await prisma.users.create({ data: { uid: 'local-uid-admin', email: 'admin@example.com', user_name: 'local_admin', age: 30, private: false } });
    const alice = await prisma.users.create({ data: { uid: 'local-uid-alice', email: 'alice@example.com', user_name: 'local_alice', age: 28, private: false } });
    const bob = await prisma.users.create({ data: { uid: 'local-uid-bob', email: 'bob@example.com', user_name: 'local_bob', age: 35, private: true } });

    for (const user of [admin, alice, bob]) {
      for (let i = 0; i < beers.length; i++) {
        await prisma.user_beers.create({ data: { user_id: user.id, beer_id: beers[i].id, liked: i === 0 } });
      }
    }

    const collection = await prisma.collections.create({ data: { name: 'Local Test Collection', difficulty: 1, description: 'Synthetic local test collection.' } });
    for (const beer of beers) {
      await prisma.collection_beers.create({ data: { collection_id: collection.id, beer_id: beer.id } });
    }
    await prisma.user_badges.create({ data: { user_id: alice.id, collection_id: collection.id, earned: false, progress: 0.33 } });
    await prisma.user_badges.create({ data: { user_id: bob.id, collection_id: collection.id, earned: true, progress: 1 } });

    const lo = Math.min(alice.id, bob.id);
    const hi = Math.max(alice.id, bob.id);
    await prisma.friends.create({ data: { user_1: lo, user_2: hi } });

    await prisma.notifications.create({ data: { user_id: alice.id, type: 'NEW_FRIEND', message: 'local-test: bob added you as a friend', viewed: false } });
    await prisma.notifications.create({ data: { user_id: bob.id, type: 'BADGE_EARNED', message: 'local-test: you earned Local Test Collection', viewed: true } });

    await prisma.api_keys.create({ data: { key: 'PLACEHOLDERHASH.localtestsalt', name: 'local-test key one', revoked: false } });
    await prisma.api_keys.create({ data: { key: 'PLACEHOLDERHASH2.localtestsalt2', name: 'local-test key two', revoked: true } });

    await prisma.beverage_images.deleteMany({ where: { beverage_id: beers[0].id, source_url: 'https://example.com/placeholder-beer.png' } });
    await prisma.beverage_images.create({ data: { beverage_id: beers[0].id, source_type: 'seed', source_url: 'https://example.com/placeholder-beer.png', storage_key: 'https://example.com/placeholder-beer.png', license_type: 'CC0', attribution: 'Local seed placeholder', license_url: 'https://example.com/license', status: 'approved' } });
    await prisma.beverage_images.create({ data: { beverage_id: beers[0].id, source_type: 'seed', source_url: 'https://example.com/pending-beer.png', storage_key: '', license_type: 'CC0', attribution: 'Local seed placeholder', license_url: 'https://example.com/license', status: 'pending' } });

    console.log('Seed complete: 3 users, 1 collection, badges, friends, notifications, 2 api keys, 2 beverage images.');
  } finally {
    await prisma.$disconnect();
  }
};

main().catch((e) => { console.error(e); process.exit(1); });
