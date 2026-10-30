import assert from "node:assert/strict";
import test from "node:test";
import { createClientQuota } from "../lib/client-quota.js";

test("stale client buckets from a previous UTC day are dropped on consume", async () => {
  let day = "2026-01-01";
  const quota = createClientQuota({ today: () => day, maxBuckets: 10 });
  await quota.tryConsume("alice", 50);
  await quota.tryConsume("bob", 50);
  day = "2026-01-02";
  await quota.tryConsume("carol", 50);
  assert.equal(quota.buckets.has("alice"), false);
  assert.equal(quota.buckets.has("bob"), false);
  assert.deepEqual(quota.buckets.get("carol"), { day: "2026-01-02", count: 1 });
});

test("client buckets stay bounded when distinct ids keep arriving", async () => {
  const quota = createClientQuota({ today: () => "2026-01-01", maxBuckets: 2 });
  assert.equal(await quota.tryConsume("a", 50), true);
  assert.equal(await quota.tryConsume("b", 50), true);
  assert.equal(await quota.tryConsume("c", 50), "client_capacity");
  assert.equal(quota.buckets.size, 2);
  assert.equal(quota.buckets.has("a"), true);
  assert.equal(quota.buckets.has("b"), true);
  assert.equal(quota.buckets.has("c"), false);
});

test("capacity eviction does not reset an existing client's daily count", async () => {
  const quota = createClientQuota({ today: () => "2026-01-01", maxBuckets: 2 });
  assert.equal(await quota.tryConsume("alice", 2), true);
  assert.equal(await quota.tryConsume("bob", 2), true);
  assert.equal(await quota.tryConsume("carol", 2), "client_capacity");
  assert.equal(await quota.tryConsume("alice", 2), true);
  assert.equal(await quota.tryConsume("alice", 2), "client_limit");
  assert.deepEqual(quota.buckets.get("alice"), { day: "2026-01-01", count: 2 });
});

test("released buckets can be reused without dropping in-use counts", async () => {
  const quota = createClientQuota({ today: () => "2026-01-01", maxBuckets: 2 });
  assert.equal(await quota.tryConsume("alice", 2), true);
  assert.equal(await quota.tryConsume("bob", 2), true);
  await quota.release("alice");
  assert.equal(await quota.tryConsume("carol", 2), true);
  assert.equal(quota.buckets.has("alice"), false);
  assert.deepEqual(quota.buckets.get("bob"), { day: "2026-01-01", count: 1 });
  assert.deepEqual(quota.buckets.get("carol"), { day: "2026-01-01", count: 1 });
});

test("same-day consume still enforces the per-client limit", async () => {
  const quota = createClientQuota({ today: () => "2026-01-01" });
  assert.equal(await quota.tryConsume("alice", 2), true);
  assert.equal(await quota.tryConsume("alice", 2), true);
  assert.equal(await quota.tryConsume("alice", 2), "client_limit");
  await quota.release("alice");
  assert.equal(await quota.tryConsume("alice", 2), true);
});

test("concurrent first-time clients cannot grow the map past maxBuckets", async () => {
  const quota = createClientQuota({ today: () => "2026-01-01", maxBuckets: 3 });
  const results = await Promise.all(
    ["a", "b", "c", "d", "e"].map((id) => quota.tryConsume(id, 50)),
  );
  assert.equal(results.filter((result) => result === true).length, 3);
  assert.equal(results.filter((result) => result === "client_capacity").length, 2);
  assert.equal(quota.buckets.size, 3);
});

test("concurrent consumes for one client cannot exceed the daily limit", async () => {
  const quota = createClientQuota({ today: () => "2026-01-01" });
  const results = await Promise.all(
    Array.from({ length: 20 }, () => quota.tryConsume("alice", 5)),
  );
  assert.equal(results.filter((result) => result === true).length, 5);
  assert.equal(results.filter((result) => result === "client_limit").length, 15);
  assert.deepEqual(quota.buckets.get("alice"), { day: "2026-01-01", count: 5 });
});
