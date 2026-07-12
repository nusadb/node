// TypeScript declarations for the nusadb Node.js driver.

import type { ConnectionOptions as TlsConnectionOptions } from 'tls';

export interface ConnectOptions {
  host?: string;
  port?: number;
  user?: string;
  database?: string;
  password?: string | null;
  /** TLS options passed to `tls.connect`; omit for a plaintext connection. */
  tls?: TlsConnectionOptions | null;
  /**
   * When `true` (the default), the server runs each statement on its own implicit transaction. When
   * `false`, a transaction is opened lazily before the first statement and ended by
   * {@link Connection.commit} / {@link Connection.rollback}.
   */
  autocommit?: boolean;
}

export type Param = string | number | boolean | Buffer | null | undefined;

/**
 * A decoded cell value. The driver decodes each cell to its natural JS type by the column's
 * protocol 1.1 type tag: `BOOL` → boolean, `INT` → number (or `bigint` beyond the safe-integer
 * range), `FLOAT` → number, `DATE`/`TIMESTAMP`/`TIMESTAMPTZ` → `Date`, `JSON` → parsed value,
 * `ARRAY` → array, `BYTEA` → `Buffer`; `NUMERIC`/`UUID`/`TIME`/`INTERVAL`/`TEXT` stay strings.
 * `null` is SQL NULL.
 */
export type Cell =
  | string
  | number
  | bigint
  | boolean
  | Buffer
  | Date
  | unknown[]
  | Record<string, unknown>
  | null;

export interface QueryResult {
  /** Output column names (empty for a non-row statement). */
  columns: string[];
  /**
   * Per-column type name, parallel to `columns` (protocol 1.1). A canonical name such as
   * `'INT'` / `'TEXT'` / `'TIMESTAMP'`, or `null` when the server answered with the untyped
   * (1.0) row description.
   */
  columnTypes: Array<string | null>;
  /** Rows of decoded cells (see {@link Cell}); `null` is SQL NULL. */
  rows: Cell[][];
  /** Row count for SELECT, affected count for DML, or null. */
  rowCount: number | null;
  /** The server's command tag (e.g. "SELECT 3", "INSERT 1"). */
  command: string | null;
}

export interface PreparedStatement {
  readonly name: string;
  execute(params?: Param[]): Promise<QueryResult>;
}

export declare class NusaError extends Error {
  readonly code: string;
  readonly sqlMessage: string;
}

export declare class Connection {
  static connect(options?: ConnectOptions): Promise<Connection>;
  readonly backendKey: { pid: number; secret: number } | null;
  query(sql: string, params?: Param[]): Promise<QueryResult>;
  prepare(sql: string): Promise<PreparedStatement>;
  /** Commit the current transaction (no-op in autocommit mode or with no open transaction). */
  commit(): Promise<void>;
  /** Roll back the current transaction (no-op in autocommit mode or with no open transaction). */
  rollback(): Promise<void>;
  close(): Promise<void>;
}

export interface PoolOptions extends ConnectOptions {
  maxSize?: number;
}

export declare class Pool {
  constructor(options?: PoolOptions);
  readonly idleCount: number;
  acquire(): Promise<Connection>;
  release(conn: Connection): void;
  withConnection<T>(fn: (conn: Connection) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export declare function connect(options?: ConnectOptions): Promise<Connection>;
