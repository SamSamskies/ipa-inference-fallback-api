import { todayUtc } from "./env.js";

/** Per-process daily client buckets. Vercel instances do not share this state. */
export function createClientQuota({
  today = todayUtc,
  maxBuckets = 10_000,
} = {}) {
  const buckets = new Map();

  function prune(day) {
    for (const [id, bucket] of buckets) {
      if (bucket.day !== day) buckets.delete(id);
    }
  }

  function evictOne(keepKey) {
    if (buckets.size < maxBuckets) return;
    for (const id of buckets.keys()) {
      if (id === keepKey) continue;
      buckets.delete(id);
      return;
    }
  }

  return {
    buckets,
    tryConsume(key, limit) {
      const day = today();
      prune(day);
      const cur = buckets.get(key);
      if (!cur || cur.day !== day) {
        evictOne(key);
        buckets.set(key, { day, count: 1 });
        return true;
      }
      if (cur.count >= limit) return false;
      cur.count += 1;
      return true;
    },
    release(key) {
      const day = today();
      const cur = buckets.get(key);
      if (!cur || cur.day !== day || cur.count <= 0) return;
      cur.count -= 1;
    },
  };
}

export const clientQuota = createClientQuota();
