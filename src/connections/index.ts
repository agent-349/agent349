// Connections module: named, lazily-opened connections shared by integration tools.
export { ConnectionManager } from './ConnectionManager.js';
export type { ConnectionManagerOptions } from './ConnectionManager.js';
export { ConnectionDriver } from './types.js';
export type {
  ColumnDescriptor,
  ConnectionConfig,
  ConnectionConfigBase,
  ConnectionHandle,
  ConnectionPoolConfig,
  ConnectionType,
  ConnectionsConfig,
  HttpConnectionConfig,
  InjectedConnection,
  MailConnectionConfig,
  MongoConnectionConfig,
  RelationDescriptor,
  SqlConnectionConfig,
} from './types.js';
