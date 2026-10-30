import { todayUtc } from "./env.js";

/** Per-process daily client buckets. Vercel instances do not share this state. */
export function createClientQuota({
  today = todayUtc,
  maxBuckets = 10_000,
} = {}) {
  const buckets = new Map();
  const pending = new Map();
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

  function remember(key, day) {
    const days = pending.get(key);
    if (days) days.push(day);
    else pending.set(key, [day]);
  }

  function takePendingDay(store, key) {
    const days = store.get(key);
    if (!days?.length) return undefined;
    const day = days.shift();
    if (days.length === 0) store.delete(key);
    return day;
  }

  function takeSlot(key, limit) {
    const day = today();
    prune(day);
    const cur = buckets.get(key);
    if (!cur || cur.day !== day) {
      if (buckets.size >= maxBuckets) evictReleased();
      if (buckets.size >= maxBuckets) return "client_capacity";
      buckets.set(key, { day, count: 1 });
      remember(key, day);
      return true;
    }
    if (cur.count >= limit) return "client_limit";
    cur.count += 1;
    remember(key, day);
    return true;
  }

  return {
    buckets,
    tryConsume(key, limit) {
      return withLock(() => takeSlot(key, limit));
    },
    commit(key) {
      return withLock(() => {
        takePendingDay(pending, key);
      });
    },
    release(key) {
      return withLock(() => {
        const day = takePendingDay(pending, key);
        if (!day) return;
        const cur = buckets.get(key);
        if (!cur || cur.day !== day || cur.count <= 0) return;
        cur.count -= 1;
      });
    },
  };
}

export const clientQuota = createClientQuota();
