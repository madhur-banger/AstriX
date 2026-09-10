import { beforeAll, afterAll, afterEach, beforeEach } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose from "mongoose";

let mongod: MongoMemoryReplSet;

// Tracks which models we've already forced into existence, so we don't
// redo this work before every single test - just the first time each
// model shows up.
const initializedModels = new Set<string>();

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongod.getUri());
});

// NEW: runs before every test. By the time THIS fires, the test file's own
// top-level imports (which register models like RoleModel, UserModel, etc.
// via `mongoose.model(...)`) have already executed - so mongoose.modelNames()
// is populated here, unlike in beforeAll above, which runs before the test
// file's imports resolve.
//
// `.init()` explicitly creates the collection and builds its indexes RIGHT
// NOW, as a plain (non-transactional) operation. That's the whole fix: it
// guarantees "does this collection exist" is already answered before any
// transaction gets anywhere near it, so the transaction never hits the
// implicit-creation-triggers-a-lock-wait path that was failing.
beforeEach(async () => {
  const pending = mongoose
    .modelNames()
    .filter((name) => !initializedModels.has(name));
  await Promise.all(
    pending.map(async (name) => {
      await mongoose.model(name).init();
      initializedModels.add(name);
    })
  );
});

afterEach(async () => {
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key].deleteMany({});
  }
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
