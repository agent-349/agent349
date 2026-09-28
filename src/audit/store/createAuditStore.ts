import type { AuditStoreConfig } from '../../config/ConfigLoader.js';
import { ConfigError } from '../../errors/index.js';
import { AuditStoreAdapter } from './AuditStoreAdapter.js';
import { InMemoryAuditStore } from './InMemoryAuditStore.js';

/**
 * Builds an {@link AuditStoreAdapter} from a resolved {@link AuditStoreConfig}.
 *
 * - `'memory'` — returns an {@link InMemoryAuditStore} synchronously.
 * - `'mongo'`  — dynamically imports `MongoAuditStore` (which itself imports the
 *   optional `mongodb` package). Requires `npm install mongodb`.
 *
 * The Orchestrator depends only on this factory and the {@link AuditStoreAdapter}
 * abstraction, so MongoDB stays out of the core's import graph.
 *
 * @throws {@link ConfigError} if the `mongodb` package is not installed.
 */
export async function createAuditStore(config: AuditStoreConfig): Promise<AuditStoreAdapter> {
  switch (config.type) {
    case 'memory':
      return new InMemoryAuditStore();

    case 'mongo': {
      const { MongoAuditStore } = await importMongoAuditStore();
      return MongoAuditStore.create({
        uri: config.uri,
        database: config.database,
        ...(config.collection !== undefined && { collection: config.collection }),
        ...(config.retentionDays !== undefined && { retentionDays: config.retentionDays }),
        ...(config.writeConcern !== undefined && { writeConcern: config.writeConcern }),
      });
    }
  }
}

async function importMongoAuditStore(): Promise<typeof import('./MongoAuditStore.js')> {
  try {
    return await import('./MongoAuditStore.js');
  } catch {
    throw new ConfigError(
      'MongoAuditStore requires mongodb. Install it: npm install mongodb',
      'audit.store.type',
    );
  }
}
