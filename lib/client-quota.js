import { todayUtc } from "./env.js";

/** Per-process daily client buckets. Vercel instances do not share this state. */
export function createClientQuota({
  today = todayUtc,
  maxBuckets = 10_000,
} = {}) {
  const buckets = new Map();
  const pending = new Set();
  let tail = Promise.resolve();

  function prune(day) {
    for (const [id, bucket] of buckets) {
      if (bucket.day !== day) buckets.delete(id);
    }
  }

  function evictReleased() {
    for (const [id, bucket] of buckets) {
      if (bucket.count <= 0) buckets.delete(id);
    }
  }

  function withLock(fn) {
    const next = tail.then(fn, fn);
    tail = next.catch(() => {});
    return next;
  }

  function reserve(key, day) {
    const reservation = { key, day };
    pending.add(reservation);
    return reservation;
  }

  function takeSlot(key, limit) {
    const day = today();
    prune(day);
    const cur = buckets.get(key);
    if (!cur || cur.day !== day) {
      if (buckets.size >= maxBuckets) evictReleased();
      if (buckets.size >= maxBuckets) return "client_capacity";
      buckets.set(key, { day, count: 1 });
      return reserve(key, day);
    }
    if (cur.count >= limit) return "client_limit";
    cur.count += 1;
    return reserve(key, day);
  }

  return {
    buckets,
    tryConsume(key, limit) {
      return withLock(() => takeSlot(key, limit));
    },
    commit(reservation) {
      return withLock(() => {
        pending.delete(reservation);
      });
    },
    release(reservation) {
      return withLock(() => {
        if (!pending.delete(reservation)) return;
        const cur = buckets.get(reservation.key);
        if (!cur || cur.day !== reservation.day || cur.count <= 0) return;
        cur.count -= 1;
      });
    },
  };
}

export const clientQuota = createClientQuota();
