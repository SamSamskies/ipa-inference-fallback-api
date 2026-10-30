import assert from "node:assert/strict";
import test from "node:test";
import { createClientQuota } from "../lib/client-quota.js";

test("stale client buckets from a previous UTC day are dropped on consume", () => {
  let day = "2026-01-01";
  const quota = createClientQuota({ today: () => day, maxBuckets: 10 });
  quota.tryConsume("alice", 50);
  quota.tryConsume("bob", 50);
  day = "2026-01-02";
  quota.tryConsume("carol", 50);
  assert.equal(quota.buckets.has("alice"), false);
  assert.equal(quota.buckets.has("bob"), false);
  assert.deepEqual(quota.buckets.get("carol"), { day: "2026-01-02", count: 1 });
});

test("client buckets stay bounded when distinct ids keep arriving", () => {
  const quota = createClientQuota({ today: () => "2026-01-01", maxBuckets: 2 });
  assert.equal(quota.tryConsume("a", 50), true);
  assert.equal(quota.tryConsume("b", 50), true);
  assert.equal(quota.tryConsume("c", 50), "client_capacity");
  assert.equal(quota.buckets.size, 2);
  assert.equal(quota.buckets.has("a"), true);
  assert.equal(quota.buckets.has("b"), true);
  assert.equal(quota.buckets.has("c"), false);
});

test("capacity eviction does not reset an existing client's daily count", () => {
  const quota = createClientQuota({ today: () => "2026-01-01", maxBuckets: 2 });
  assert.equal(quota.tryConsume("alice", 2), true);
  assert.equal(quota.tryConsume("bob", 2), true);
  assert.equal(quota.tryConsume("carol", 2), "client_capacity");
  assert.equal(quota.tryConsume("alice", 2), true);
  assert.equal(quota.tryConsume("alice", 2), "client_limit");
  assert.deepEqual(quota.buckets.get("alice"), { day: "2026-01-01", count: 2 });
});

test("released buckets can be reused without dropping in-use counts", () => {
  const quota = createClientQuota({ today: () => "2026-01-01", maxBuckets: 2 });
  assert.equal(quota.tryConsume("alice", 2), true);
  assert.equal(quota.tryConsume("bob", 2), true);
  quota.release("alice");
  assert.equal(quota.tryConsume("carol", 2), true);
  assert.equal(quota.buckets.has("alice"), false);
  assert.deepEqual(quota.buckets.get("bob"), { day: "2026-01-01", count: 1 });
  assert.deepEqual(quota.buckets.get("carol"), { day: "2026-01-01", count: 1 });
});

test("same-day consume still enforces the per-client limit", () => {
  const quota = createClientQuota({ today: () => "2026-01-01" });
  assert.equal(quota.tryConsume("alice", 2), true);
  assert.equal(quota.tryConsume("alice", 2), true);
  assert.equal(quota.tryConsume("alice", 2), "client_limit");
  quota.release("alice");
  assert.equal(quota.tryConsume("alice", 2), true);
});
