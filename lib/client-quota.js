import { todayUtc } from "./env.js";

/** Per-process daily client buckets. Vercel instances do not share this state. */
export function createClientQuota({
  today = todayUtc,
  maxBuckets = 10_000,
} = {}) {
  const buckets = new Map();
  const pending = new Set();
  const priors = new Map();
  let tail = Promise.resolve();

  function hasPending(key, day) {
    for (const reservation of pending) {
      if (reservation.key === key && reservation.day === day) return true;
    }
    return false;
  }

  function prune(day) {
    for (const [id, bucket] of buckets) {
      if (bucket.day === day) continue;
      if (hasPending(id, bucket.day) || priors.has(id)) continue;
      buckets.delete(id);
    }
  }

  function evictReleased() {
    for (const [id, bucket] of buckets) {
      if (bucket.count > 0) continue;
      if (hasPending(id, bucket.day) || priors.has(id)) continue;
      buckets.delete(id);
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

  function dropPriorIfIdle(key, day) {
    const prior = priors.get(key);
    if (prior && prior.day === day && !hasPending(key, day)) {
      priors.delete(key);
    }
  }

  function takeSlot(key, limit) {
    const day = today();
    prune(day);
    const cur = buckets.get(key);
    if (!cur || cur.day !== day) {
      if (!cur) {
        if (buckets.size >= maxBuckets) evictReleased();
        if (buckets.size >= maxBuckets) return "client_capacity";
      } else if (hasPending(key, cur.day)) {
        priors.set(key, { day: cur.day, count: cur.count });
      } else {
        priors.delete(key);
      }
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
        if (!pending.delete(reservation)) return;
        dropPriorIfIdle(reservation.key, reservation.day);
      });
    },
    release(reservation) {
      return withLock(() => {
        if (!pending.delete(reservation)) return;
        const cur = buckets.get(reservation.key);
        if (cur?.day === reservation.day && cur.count > 0) {
          cur.count -= 1;
        } else {
          const prior = priors.get(reservation.key);
          if (prior?.day === reservation.day && prior.count > 0) {
            prior.count -= 1;
          }
        }
        dropPriorIfIdle(reservation.key, reservation.day);
      });
    },
  };
}

export const clientQuota = createClientQuota();
