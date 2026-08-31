export interface TokenBucketOptions {
  capacity: number;
  refillPerMinute: number;
  now?: (() => number) | undefined;
}

export interface TokenBucket {
  take(identity: string, count: number): boolean;
}

// One bucket store belongs to one createApp instance. Keeping the mutable
// state behind this small service prevents extracted routers from accidentally
// creating independent spending limits for the same API key.
export function createTokenBucket(options: TokenBucketOptions): TokenBucket {
  const buckets = new Map<string, { tokens: number; refilledAt: number }>();
  const now = options.now ?? Date.now;

  return {
    take(identity, count) {
      const currentTime = now();
      const bucket = buckets.get(identity) ?? {
        tokens: options.capacity,
        refilledAt: currentTime
      };
      bucket.tokens = Math.min(
        options.capacity,
        bucket.tokens + ((currentTime - bucket.refilledAt) / 60_000) * options.refillPerMinute
      );
      bucket.refilledAt = currentTime;
      buckets.set(identity, bucket);
      if (bucket.tokens < count) return false;
      bucket.tokens -= count;
      return true;
    }
  };
}
