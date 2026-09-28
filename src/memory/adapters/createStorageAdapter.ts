import type { StorageBackendConfig } from '../../config/ConfigLoader.js';
import { ConfigError } from '../../errors/index.js';
import type { StorageAdapter } from './StorageAdapter.js';
import { InMemoryAdapter } from './InMemoryAdapter.js';

/**
 * Builds a {@link StorageAdapter} from a fully-resolved {@link StorageBackendConfig}.
 *
 * - `'memory'` — returns an `InMemoryAdapter` synchronously.
 * - `'redis'`  — dynamically imports `ioredis`. Requires `npm install ioredis`.
 * - `'mongo'`  — dynamically imports `mongodb`. Requires `npm install mongodb`.
 *
 * @throws {@link ConfigError} if a required optional package is not installed.
 */
export async function createStorageAdapter(config: StorageBackendConfig): Promise<StorageAdapter> {
  switch (config.type) {
    case 'memory':
      return new InMemoryAdapter();

    case 'redis': {
      const { RedisAdapter } = await importRedisAdapter();
      return RedisAdapter.create(config);
    }

    case 'mongo': {
      const { MongoAdapter } = await importMongoAdapter();
      return MongoAdapter.create(config);
    }
  }
}

async function importRedisAdapter(): Promise<typeof import('./RedisAdapter.js')> {
  try {
    return await import('./RedisAdapter.js');
  } catch {
    throw new ConfigError(
      'RedisAdapter requires ioredis. Install it: npm install ioredis',
      'storage.backends.type',
    );
  }
}

async function importMongoAdapter(): Promise<typeof import('./MongoAdapter.js')> {
  try {
    return await import('./MongoAdapter.js');
  } catch {
    throw new ConfigError(
      'MongoAdapter requires mongodb. Install it: npm install mongodb',
      'storage.backends.type',
    );
  }
}
