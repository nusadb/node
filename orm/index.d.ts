// TypeScript declarations for nusadb-orm — the native NusaDB ORM / query builder.
//
// Generic over a row shape `T`: `orm.model<User>('app_user')` gives a `Model<User>` whose
// `select().all()` resolves to `User[]`, `first()` to `User | null`, and so on. The runtime is
// plain JavaScript; these declarations add no behavior.

import type { Connection, ConnectOptions, Param, QueryResult } from 'nusadb';

/** Default row shape when a model is not parameterized. */
export type Row = Record<string, unknown>;

/** Operator object for a `where` condition on a column of value type `V`. */
export interface Operators<V = unknown> {
  gt?: V;
  gte?: V;
  lt?: V;
  lte?: V;
  ne?: V;
  in?: V[];
  notIn?: V[];
  like?: string;
  ilike?: string;
  /** Inclusive range `[low, high]` → `BETWEEN low AND high`. */
  between?: [V, V];
  /** `true` → `IS NULL`, `false` → `IS NOT NULL`. */
  isNull?: boolean;
}

/** A single column condition: a plain value (equality; `null` → `IS NULL`) or an operator object. */
export type Condition<V = unknown> = V | Operators<V>;

/**
 * A `where` map keyed by the row's columns (every entry optional), plus optional `$or`/`$and` group
 * keys whose value is an array of nested clauses combined with `OR`/`AND`.
 */
export type WhereClause<T> = {
  [K in keyof T]?: Condition<T[K]>;
} & {
  $or?: WhereClause<T>[];
  $and?: WhereClause<T>[];
};

/** Sort direction for `orderBy`. */
export type Direction = 'asc' | 'desc' | 'ASC' | 'DESC';

/** A column's NusaDB type name (or any string that maps through to DDL). */
export type ColumnTypeName =
  | 'int'
  | 'bigint'
  | 'text'
  | 'bool'
  | 'boolean'
  | 'float'
  | 'numeric'
  | 'timestamp'
  | 'date'
  | 'time'
  | 'uuid'
  | 'json'
  | (string & {});

/** A column definition for `model()` / `createTable()`. */
export interface ColumnSpec {
  type: ColumnTypeName;
  notNull?: boolean;
  primaryKey?: boolean;
}

/** The `{ column: type }` map: a type name or a full spec per column. */
export type Columns = Record<string, ColumnTypeName | ColumnSpec>;

/** Options for declaring a relation. `localKey` defaults to `'id'`; `foreignKey` is required. */
export interface RelationOptions {
  foreignKey: string;
  localKey?: string;
}

/** A schema diff between a model and the live table (`Model.diffSchema`). */
export interface SchemaDiff {
  /** Whether the table currently exists. */
  exists: boolean;
  /** Model columns absent from the live table (candidates for `ADD COLUMN`). */
  missing: Array<{ name: string; spec: ColumnSpec }>;
  /** Live columns not present in the model (never auto-dropped). */
  extra: string[];
  /** Columns whose live type differs from the model's (never auto-altered). */
  mismatched: Array<{ name: string; modelType: string; liveType: string }>;
}

/** The additive migration plan for a model (`Model.migrationPlan`). */
export interface MigrationPlan {
  /** The `CREATE TABLE` / `ADD COLUMN` statements to run (additive only). */
  statements: string[];
  diff: SchemaDiff;
  /** Names of missing `NOT NULL` columns added nullable (a `NOT NULL` add would fail on a populated table). */
  relaxedNotNull: string[];
}

/** The result of applying a migration plan (`Model.syncSchema`). */
export interface SyncResult {
  /** The statements that were executed (empty when the table already matched). */
  applied: string[];
  diff: SchemaDiff;
  relaxedNotNull: string[];
}

/** Reads. `all()` returns every matching row; `first()` one (or `null`); `count()` a number. */
export declare class SelectBuilder<T = Row> {
  where(eq: WhereClause<T>): this;
  /** Restrict the projection (varargs or an array); pair with `.join()` to avoid name collisions. */
  columns(...cols: Array<keyof T | string | Array<keyof T | string>>): this;
  /** Project raw SQL expressions verbatim (aggregates / computed columns under `.groupBy()`). */
  selectRaw(...exprs: Array<string | string[]>): this;
  /** Emit `SELECT DISTINCT`. */
  distinct(): this;
  /** `GROUP BY` these columns; pair with `.selectRaw()` to project the aggregates. */
  groupBy(...cols: Array<keyof T | string | Array<keyof T | string>>): this;
  /** `HAVING <fragment>`; use `?` placeholders for each value in `params`. */
  having(fragment: string, params?: Param[]): this;
  /** Combine via `UNION` (orderBy/limit/offset apply to the whole result). */
  union(other: SelectBuilder<any>): this;
  /** Combine via `UNION ALL`. */
  unionAll(other: SelectBuilder<any>): this;
  /** Rows present in both queries (`INTERSECT`). */
  intersect(other: SelectBuilder<any>): this;
  /** Rows in this query but not `other` (`EXCEPT`). */
  except(other: SelectBuilder<any>): this;
  /** `INNER JOIN <table> ON <on>`; `on` is a raw SQL fragment of table-qualified column references. */
  join(table: string, on: string): this;
  /** `LEFT JOIN <table> ON <on>` (see {@link join}). */
  leftJoin(table: string, on: string): this;
  /** `RIGHT JOIN <table> ON <on>` (see {@link join}). */
  rightJoin(table: string, on: string): this;
  /** `FULL JOIN <table> ON <on>` (see {@link join}). */
  fullJoin(table: string, on: string): this;
  /** `CROSS JOIN <table>` (cartesian product; no `ON`). */
  crossJoin(table: string): this;
  orderBy(column: keyof T | string, direction?: Direction): this;
  limit(n: number): this;
  offset(n: number): this;
  /** Eager-load declared relations onto each row (varargs or an array of relation names). */
  include(...names: Array<string | string[]>): this;
  all(): Promise<T[]>;
  first(): Promise<T | null>;
  count(): Promise<number>;
  /** Sum of a column (honours `where`/joins) as a number, or `null` when there are no rows. */
  sum(column: keyof T | string): Promise<number | null>;
  /** Arithmetic mean of a column as a number, or `null` when there are no rows. */
  avg(column: keyof T | string): Promise<number | null>;
  /** Minimum of a column (typed by the server), or `null` when there are no rows. */
  min(column: keyof T | string): Promise<unknown>;
  /** Maximum of a column (typed by the server), or `null` when there are no rows. */
  max(column: keyof T | string): Promise<unknown>;
}

/** Insert builder; awaiting it runs the statement and resolves to the inserted row (or `null`). */
export interface InsertBuilder<T = Row> extends Promise<T | null> {}

/** Update builder; set `where()` then await to run, resolving to the updated rows. */
export interface UpdateBuilder<T = Row> extends Promise<T[]> {
  where(eq: WhereClause<T>): this;
}

/** Delete builder; set `where()` then await to run, resolving to the deleted rows. */
export interface DeleteBuilder<T = Row> extends Promise<T[]> {
  where(eq: WhereClause<T>): this;
}

/** A table mapping. Parameterize with the row shape: `orm.model<User>('app_user')`. */
export declare class Model<T = Row> {
  readonly table: string;
  readonly columns: Columns;
  select(): SelectBuilder<T>;
  insert(data: Partial<T> | Record<string, Param>): InsertBuilder<T>;
  update(data: Partial<T> | Record<string, Param>): UpdateBuilder<T>;
  delete(): DeleteBuilder<T>;
  /** The `CREATE TABLE` SQL for this model's columns. */
  createTableSql(options?: { ifNotExists?: boolean }): string;
  createTable(options?: { ifNotExists?: boolean }): Promise<void>;
  dropTable(options?: { ifExists?: boolean }): Promise<void>;
  /** Compare the model's columns against the live table via `information_schema`. */
  diffSchema(): Promise<SchemaDiff>;
  /** The additive statements (CREATE / ADD COLUMN) to align the live table with the model. */
  migrationPlan(): Promise<MigrationPlan>;
  /** Apply the additive migration plan; a no-op when the table already matches. */
  syncSchema(): Promise<SyncResult>;
  /** This model's `foreignKey` references `target`'s `localKey` (default `'id'`). */
  belongsTo(name: string, target: Model<any>, opts: RelationOptions): this;
  /** `target`'s `foreignKey` references this model's `localKey` (default `'id'`); value is an array. */
  hasMany(name: string, target: Model<any>, opts: RelationOptions): this;
  /** Like `hasMany` but the value is a single row or `null`. */
  hasOne(name: string, target: Model<any>, opts: RelationOptions): this;
  /** Lazily load a declared relation onto already-fetched row(s), in place; returns the same row(s). */
  loadRelated<R extends T | T[]>(rowsOrRow: R, name: string): Promise<R>;
}

/** The ORM, bound to one NusaDB connection. */
export declare class Orm {
  readonly conn: Connection;
  static connect(options?: ConnectOptions): Promise<Orm>;
  model<T = Row>(table: string, columns?: Columns): Model<T>;
  /** Run a raw SQL statement (escape hatch); returns the underlying driver result. */
  raw(sql: string, params?: Param[]): Promise<QueryResult>;
  /** Run `work` in a transaction: COMMIT on success, ROLLBACK if it throws. */
  transaction<R>(work: (tx: Orm) => Promise<R>): Promise<R>;
  close(): Promise<void>;
}

/** One versioned schema migration. */
export interface Migration {
  version: string;
  up(orm: Orm): Promise<void> | void;
  down?(orm: Orm): Promise<void> | void;
}

export interface MigratorOptions {
  /** Bookkeeping table name (default `schema_migrations`); must not start with `nusadb_`. */
  table?: string;
}

export interface MigrationStatus {
  version: string;
  applied: boolean;
}

/** Versioned schema migration runner. */
export declare class Migrator {
  constructor(orm: Orm, migrations: Migration[], options?: MigratorOptions);
  /** Apply every pending migration in version order; returns the versions applied this run. */
  migrate(): Promise<string[]>;
  /** Roll back the last `steps` applied migrations (default 1), newest first. */
  rollback(steps?: number): Promise<string[]>;
  /** Each known migration with whether it has been applied, in version order. */
  status(): Promise<MigrationStatus[]>;
}

/** Quote an SQL identifier (double-quote, doubling embedded quotes). */
export declare function quoteIdent(name: string): string;

/** Quote an SQL string literal (single-quote, doubling embedded quotes). */
export declare function quoteString(value: unknown): string;
