import { config } from '../config';

export interface Cache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  del(pattern: string): Promise<void>;
  flush(): Promise<void>;
}

interface Entry {
  value: unknown;
  expiresAt: number;
}

/** In-memory cache. Used in tests and as a fallback when Redis is unavailable. */
export class MemoryCache implements Cache {
  private store = new Map<string, Entry>();

  async get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlSeconds = config.cacheTtlSeconds): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async del(pattern: string): Promise<void> {
    const prefix = pattern.replace(/\*$/, '');
    for (const key of this.store.keys()) {
      if (key === pattern || key.startsWith(prefix)) this.store.delete(key);
    }
  }

  async flush(): Promise<void> {
    this.store.clear();
  }
}

let cacheInstance: Cache | null = null;

export function getCache(): Cache {
  if (!cacheInstance) {
    // Redis wiring is intentionally lazy; tests and default runs use MemoryCache.
    // A RedisCache implementing the same interface can be swapped in here when
    // config.useRedis is true.
    cacheInstance = new MemoryCache();
  }
  return cacheInstance;
}

export function setCache(cache: Cache): void {
  cacheInstance = cache;
}
