'use strict';

// nusadb-orm — a small, native ORM / query builder for NusaDB on the `nusadb` Node driver.
//
// Native by design: it emits NusaDB's own SQL (bare table names, `$n` parameters, a constant
// `LIMIT`, `RETURNING`, double-quoted identifiers) and decodes results into typed JS values using
// the protocol 1.1 per-column type metadata (`columnTypes`) the driver returns. No third-party
// database dialect or identity is involved.

const { connect } = require('../src/index');

/** Quote an SQL identifier (double-quote, doubling any embedded quote). */
function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * Quote an SQL string literal (single-quote, doubling any embedded quote). Used for the migration
 * bookkeeping where the value is developer-authored (a migration version / timestamp), not user
 * input: a literal types unambiguously as TEXT and preserves the exact string, whereas a bound `$n`
 * param of an all-digits string (e.g. `'001'`) is type-inferred as an integer and would either be
 * rejected by a TEXT column or lose its leading zeros.
 */
function quoteString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Decode a text cell into a JS value, preferring the server's column type, then the model's. */
function decodeCell(value, typeName) {
  if (value === null || value === undefined) {
    return null;
  }
  // The driver already decodes each cell to its natural JS type by the protocol 1.1 type tag, so an
  // already-typed value (number, boolean, BigInt, Date, Buffer, parsed JSON/array) passes straight
  // through. Only a raw string still needs decoding — the case for an untyped (1.0) server, where the
  // column type comes from the model's decode-fallback map instead.
  if (typeof value !== 'string') {
    return value;
  }
  switch (typeName) {
    case 'BOOL':
      return value === 'true';
    case 'INT': {
      // NusaDB INT is 64-bit. A JS number is exact only within the safe-integer range; beyond it a
      // Number would silently lose precision (R42-B.04), so return a lossless BigInt there. Typical
      // ids/counts stay plain numbers; only genuinely 64-bit values become BigInt.
      const n = Number(value);
      return Number.isSafeInteger(n) ? n : BigInt(value);
    }
    case 'FLOAT':
      return Number(value);
    default:
      // TEXT / NUMERIC / DATE / TIME / TIMESTAMP / JSON / UUID / … stay as their text rendering.
      return value;
  }
}

/** Turn a driver result into an array of typed plain objects keyed by column name. */
function rowsToObjects(result, model) {
  const { columns, columnTypes, rows } = result;
  return rows.map((row) => {
    const obj = {};
    for (let i = 0; i < columns.length; i += 1) {
      const name = columns[i];
      let type = columnTypes && columnTypes[i];
      if (!type && model && model.columns[name]) {
        type = String(specType(model.columns[name])).toUpperCase();
      }
      obj[name] = decodeCell(row[i], type);
    }
    return obj;
  });
}

// Comparison operators usable in a `where` spec object, mapped to their SQL form.
const COMPARATORS = { gt: '>', gte: '>=', lt: '<', lte: '<=', ne: '<>' };
const OPERATOR_KEYS = new Set([
  ...Object.keys(COMPARATORS),
  'in',
  'notIn',
  'like',
  'ilike',
  'between',
  'isNull',
]);

/** Is `spec` an operator object (`{ gt: 1 }`) rather than a plain equality value? */
function isOperatorSpec(spec) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec) || spec instanceof Date) {
    return false;
  }
  const keys = Object.keys(spec);
  return keys.length > 0 && keys.every((k) => OPERATOR_KEYS.has(k));
}

/** Render `col <op> (list…)`, or the `empty` literal when the list is empty, appending params. */
function buildInList(col, op, values, empty, params) {
  const placeholders = (values || []).map((v) => {
    params.push(v);
    return `$${params.length}`;
  });
  return placeholders.length ? `${col} ${op} (${placeholders.join(', ')})` : empty;
}

/** Build the SQL for one column condition, appending any bound values to `params`. */
function buildCondition(column, spec, params) {
  const col = quoteIdent(column);
  if (!isOperatorSpec(spec)) {
    // Plain value: equality, or `IS NULL` when the value is null.
    if (spec === null || spec === undefined) {
      return `${col} IS NULL`;
    }
    params.push(spec);
    return `${col} = $${params.length}`;
  }
  const parts = [];
  for (const [op, val] of Object.entries(spec)) {
    if (op in COMPARATORS) {
      params.push(val);
      parts.push(`${col} ${COMPARATORS[op]} $${params.length}`);
    } else if (op === 'like' || op === 'ilike') {
      params.push(val);
      parts.push(`${col} ${op === 'ilike' ? 'ILIKE' : 'LIKE'} $${params.length}`);
    } else if (op === 'in') {
      // An empty `in` matches nothing.
      parts.push(buildInList(col, 'IN', val, 'FALSE', params));
    } else if (op === 'notIn') {
      // An empty `notIn` excludes nothing.
      parts.push(buildInList(col, 'NOT IN', val, 'TRUE', params));
    } else if (op === 'between') {
      params.push(val[0]);
      const lo = params.length;
      params.push(val[1]);
      parts.push(`${col} BETWEEN $${lo} AND $${params.length}`);
    } else if (op === 'isNull') {
      parts.push(val ? `${col} IS NULL` : `${col} IS NOT NULL`);
    }
  }
  return parts.join(' AND ');
}

/**
 * Build a boolean SQL expression for a condition map (the entries ANDed), appending bound values to
 * `params`. Besides column entries, two logical group keys are supported: `$or` / `$and`, each an
 * array of sub-maps combined with `OR` / `AND` and wrapped in parentheses — e.g.
 * `{ active: true, $or: [{ role: 'admin' }, { age: { gte: 18 } }] }`.
 */
function buildClause(where, params) {
  const parts = [];
  for (const [key, val] of Object.entries(where || {})) {
    if (key === '$or' || key === '$and') {
      const sub = (val || []).map((w) => buildClause(w, params)).filter(Boolean);
      if (sub.length) {
        parts.push(`(${sub.join(key === '$or' ? ' OR ' : ' AND ')})`);
      }
    } else {
      parts.push(buildCondition(key, val, params));
    }
  }
  return parts.join(' AND ');
}

/**
 * Build a `WHERE` clause from a condition map, appending bound values to `params`. Each column entry
 * is either a plain value (equality; `null` → `IS NULL`) or an operator object, e.g.
 * `{ balance: { gt: 100 }, name: { like: 'a%' }, id: { in: [1, 2] }, age: { between: [18, 65] },
 * deleted: { isNull: true } }`; `$or`/`$and` group keys nest (see {@link buildClause}).
 */
function buildWhere(where, params) {
  const clause = buildClause(where, params);
  return clause ? ` WHERE ${clause}` : '';
}

// Model column type → NusaDB DDL type (for createTable). Unknown types pass through upper-cased.
const DDL_TYPES = {
  int: 'INT',
  bigint: 'INT',
  text: 'TEXT',
  bool: 'BOOL',
  boolean: 'BOOL',
  float: 'FLOAT',
  numeric: 'NUMERIC',
  timestamp: 'TIMESTAMP',
  date: 'DATE',
  time: 'TIME',
  uuid: 'UUID',
  json: 'JSON',
};

function ddlType(type) {
  return DDL_TYPES[String(type).toLowerCase()] || String(type).toUpperCase();
}

// Model column type → the canonical `data_type` that `information_schema.columns` reports for it, so
// a model column can be compared against the live table. Mirrors `DDL_TYPES` but in the catalog's
// spelling (e.g. a `BOOL` column reports as `boolean`, a `BIGINT`/`INT` column as `int`).
const CATALOG_TYPES = {
  int: 'int',
  bigint: 'int',
  text: 'text',
  bool: 'boolean',
  boolean: 'boolean',
  float: 'float',
  numeric: 'numeric',
  timestamp: 'timestamp',
  date: 'date',
  time: 'time',
  uuid: 'uuid',
  json: 'json',
};

/** The `information_schema.columns.data_type` a model column of `type` is expected to report as. */
function catalogType(type) {
  const t = String(type).toLowerCase();
  return CATALOG_TYPES[t] || t;
}

/** A column's declared type name, accepting either `'int'` or `{ type: 'int', ... }`. */
function specType(spec) {
  return typeof spec === 'string' ? spec : spec.type;
}

/** A stable string form of a key value, so a 64-bit `BigInt` id and a `Number` id match by value. */
function keyStr(value) {
  return typeof value === 'bigint' ? value.toString() : String(value);
}

/** Distinct non-null values of `key` across `rows`, preserving first-seen order (for an `IN` list). */
function distinctKeys(rows, key) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const v = row[key];
    if (v === null || v === undefined) {
      continue;
    }
    const k = keyStr(v);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(v);
    }
  }
  return out;
}

/**
 * Attach a declared relation onto `rows` in place (NORM-v3, R43-B.01). One batched query per
 * relation — never one-per-row — so eager- and lazy-loading are both N+1-free:
 *
 * - `belongsTo`: collect the parents' foreign-key values, fetch the targets whose local key is
 *   `IN (...)`, and set `row[name]` to the matching target (or `null`).
 * - `hasMany` / `hasOne`: collect the parents' local-key values, fetch the targets whose foreign
 *   key is `IN (...)`, group them by that key, and set `row[name]` to the group (an array for
 *   `hasMany`, the first row or `null` for `hasOne`).
 *
 * We batch via `IN` rather than a `JOIN` deliberately: a `SELECT *` join would collide duplicate
 * column names across tables (both sides tend to have `id`), and multiple `hasMany` includes would
 * produce a cartesian result needing parent de-duplication. The `IN` form needs only the key column
 * names, reuses the existing typed-decoding select path, and avoids that whole bug class.
 */
async function attachRelation(model, rel, name, rows) {
  const target = rel.target;
  if (rel.kind === 'belongsTo') {
    const ids = distinctKeys(rows, rel.foreignKey);
    const byKey = new Map();
    if (ids.length) {
      const targets = await target.select().where({ [rel.localKey]: { in: ids } }).all();
      for (const t of targets) {
        byKey.set(keyStr(t[rel.localKey]), t);
      }
    }
    for (const row of rows) {
      const fk = row[rel.foreignKey];
      row[name] = fk === null || fk === undefined ? null : byKey.get(keyStr(fk)) || null;
    }
  } else {
    // hasMany / hasOne: the foreign key lives on the target rows.
    const ids = distinctKeys(rows, rel.localKey);
    const groups = new Map();
    if (ids.length) {
      const targets = await target.select().where({ [rel.foreignKey]: { in: ids } }).all();
      for (const t of targets) {
        const k = keyStr(t[rel.foreignKey]);
        const group = groups.get(k);
        if (group) {
          group.push(t);
        } else {
          groups.set(k, [t]);
        }
      }
    }
    for (const row of rows) {
      const group = groups.get(keyStr(row[rel.localKey])) || [];
      row[name] = rel.kind === 'hasOne' ? group[0] || null : group;
    }
  }
  return rows;
}

/** Reads. `all()` returns every matching row; `first()` returns one (or `null`). */
class SelectBuilder {
  constructor(model) {
    this.model = model;
    this._where = null;
    this._order = [];
    this._limit = null;
    this._offset = null;
    this._distinct = false;
    this._columns = null;
    this._rawColumns = false;
    this._joins = [];
    this._groupBy = [];
    this._having = [];
    this._setOps = [];
    this._include = [];
  }

  where(eq) {
    this._where = eq;
    return this;
  }

  /**
   * Restrict the projection to these columns (default `*`). Accepts column names as varargs or an
   * array; each is quoted as an identifier. Use this with `.join()` so duplicate column names across
   * the joined tables don't collide when the result rows are keyed by column name.
   */
  columns(...cols) {
    this._columns = cols.flat();
    this._rawColumns = false;
    return this;
  }

  /**
   * Project raw SQL expressions verbatim (no quoting) — for aggregates and computed columns under
   * `.groupBy()`, e.g. `.selectRaw('category', 'count(*) AS n')`.
   */
  selectRaw(...exprs) {
    this._columns = exprs.flat();
    this._rawColumns = true;
    return this;
  }

  /** Emit `SELECT DISTINCT` so duplicate result rows are collapsed. */
  distinct() {
    this._distinct = true;
    return this;
  }

  /**
   * Add an `INNER JOIN <table> ON <on>`. The `on` fragment is raw SQL — reference columns with
   * table-qualified, quoted identifiers (e.g. `"orders"."user_id" = "users"."id"`) to avoid
   * ambiguity, and pair with `.columns()` to project specific columns when both sides share a name.
   * For declared model relationships prefer `.include()` (N+1-free), which is the ergonomic path.
   */
  join(table, on) {
    this._joins.push(`INNER JOIN ${quoteIdent(table)} ON ${on}`);
    return this;
  }

  /** Add a `LEFT JOIN <table> ON <on>` (see {@link join} for the `on` form). */
  leftJoin(table, on) {
    this._joins.push(`LEFT JOIN ${quoteIdent(table)} ON ${on}`);
    return this;
  }

  /** Add a `RIGHT JOIN <table> ON <on>` (see {@link join} for the `on` form). */
  rightJoin(table, on) {
    this._joins.push(`RIGHT JOIN ${quoteIdent(table)} ON ${on}`);
    return this;
  }

  /** Add a `FULL JOIN <table> ON <on>` (see {@link join} for the `on` form). */
  fullJoin(table, on) {
    this._joins.push(`FULL JOIN ${quoteIdent(table)} ON ${on}`);
    return this;
  }

  /** Add a `CROSS JOIN <table>` (cartesian product; no `ON` clause). */
  crossJoin(table) {
    this._joins.push(`CROSS JOIN ${quoteIdent(table)}`);
    return this;
  }

  /**
   * Eager-load one or more declared relations on each result row (NORM-v3, R43-B.01). Accepts
   * relation names as varargs or an array: `.include('orders')` / `.include('orders', 'profile')`.
   * Each relation is fetched with a single batched query (N+1-free).
   */
  include(...names) {
    this._include.push(...names.flat());
    return this;
  }

  orderBy(column, direction = 'asc') {
    this._order.push([column, String(direction).toUpperCase() === 'DESC' ? 'DESC' : 'ASC']);
    return this;
  }

  limit(n) {
    this._limit = n;
    return this;
  }

  offset(n) {
    this._offset = n;
    return this;
  }

  /** Group rows by these columns (`GROUP BY`); pair with `.selectRaw()` to project the aggregates. */
  groupBy(...cols) {
    this._groupBy = cols.flat();
    return this;
  }

  /**
   * Add a `HAVING` predicate over the grouped rows (ANDed). `fragment` is raw SQL referencing an
   * aggregate; use `?` for each bound value, supplied in `params`, e.g.
   * `.having('count(*) >= ?', [2])` or a constant `.having('sum(qty) > 0')`.
   */
  having(fragment, params = []) {
    this._having.push({ fragment, params });
    return this;
  }

  /**
   * Combine with another `select()` query via `UNION` (duplicates removed). `orderBy`/`limit`/
   * `offset` on this builder apply to the whole combined result.
   */
  union(other) {
    this._setOps.push(['UNION', other]);
    return this;
  }

  /** Combine via `UNION ALL` (duplicates kept). */
  unionAll(other) {
    this._setOps.push(['UNION ALL', other]);
    return this;
  }

  /** Rows present in both queries (`INTERSECT`). */
  intersect(other) {
    this._setOps.push(['INTERSECT', other]);
    return this;
  }

  /** Rows in this query but not in `other` (`EXCEPT`). */
  except(other) {
    this._setOps.push(['EXCEPT', other]);
    return this;
  }

  /**
   * The shared ` FROM <table> [joins] [WHERE ...]` fragment of `all()`, `count()`, and the aggregate
   * terminals; appends any bound `where` values to `params`.
   */
  _fromAndWhere(params) {
    let sql = ` FROM ${quoteIdent(this.model.table)}`;
    for (const j of this._joins) {
      sql += ` ${j}`;
    }
    sql += buildWhere(this._where, params);
    return sql;
  }

  /**
   * Render the core `SELECT … FROM … WHERE … GROUP BY … HAVING …` (no set-ops / `ORDER BY` /
   * `LIMIT` / `OFFSET`), appending its bound values to the shared `params` array so a set-operation
   * operand's placeholders number continuously after the outer query's.
   */
  _buildCore(params) {
    let cols = '*';
    if (this._columns && this._columns.length) {
      cols = this._columns.map((c) => (this._rawColumns ? c : quoteIdent(c))).join(', ');
    }
    let sql = `SELECT ${this._distinct ? 'DISTINCT ' : ''}${cols}`;
    sql += this._fromAndWhere(params);
    if (this._groupBy.length) {
      sql += ` GROUP BY ${this._groupBy.map(quoteIdent).join(', ')}`;
    }
    if (this._having.length) {
      const rendered = this._having.map((h) => {
        let i = 0;
        return h.fragment.replace(/\?/g, () => {
          params.push(h.params[i]);
          i += 1;
          return `$${params.length}`;
        });
      });
      sql += ` HAVING ${rendered.join(' AND ')}`;
    }
    return sql;
  }

  async all() {
    const params = [];
    let sql = this._buildCore(params);
    for (const [op, other] of this._setOps) {
      sql += ` ${op} ${other._buildCore(params)}`;
    }
    if (this._order.length) {
      const order = this._order.map(([c, d]) => `${quoteIdent(c)} ${d}`).join(', ');
      sql += ` ORDER BY ${order}`;
    }
    if (this._limit != null) {
      // NusaDB requires a constant LIMIT/OFFSET: inline the integers (they are not user data).
      sql += ` LIMIT ${Number(this._limit)}`;
    }
    if (this._offset != null) {
      sql += ` OFFSET ${Number(this._offset)}`;
    }
    const res = await this.model.orm.conn.query(sql, params);
    const objs = rowsToObjects(res, this.model);
    for (const name of this._include) {
      const rel = this.model.relations[name];
      if (!rel) {
        throw new Error(`unknown relation '${name}' on model '${this.model.table}'`);
      }
      await attachRelation(this.model, rel, name, objs);
    }
    return objs;
  }

  async first() {
    this._limit = 1;
    const rows = await this.all();
    return rows.length ? rows[0] : null;
  }

  /** Run an aggregate `SELECT <expr> FROM ...` honouring `where`/joins; returns the first cell. */
  async _aggregate(expr) {
    const params = [];
    const sql = `SELECT ${expr}${this._fromAndWhere(params)}`;
    const res = await this.model.orm.conn.query(sql, params);
    if (!res.rows.length) {
      return { cell: null, type: null };
    }
    return { cell: res.rows[0][0], type: res.columnTypes && res.columnTypes[0] };
  }

  /** Count matching rows (honours `where`/joins). Returns a JS number. */
  async count() {
    const { cell } = await this._aggregate('count(*)');
    return cell == null ? 0 : Number(cell);
  }

  /** Sum of `column` (honours `where`/joins) as a number, or `null` when there are no rows. */
  async sum(column) {
    const { cell } = await this._aggregate(`sum(${quoteIdent(column)})`);
    return cell == null ? null : Number(cell);
  }

  /** Arithmetic mean of `column` as a number, or `null` when there are no rows. */
  async avg(column) {
    const { cell } = await this._aggregate(`avg(${quoteIdent(column)})`);
    return cell == null ? null : Number(cell);
  }

  /** Minimum of `column` (typed by the server's column type), or `null` when there are no rows. */
  async min(column) {
    const { cell, type } = await this._aggregate(`min(${quoteIdent(column)})`);
    return cell == null ? null : decodeCell(cell, type);
  }

  /** Maximum of `column` (typed by the server's column type), or `null` when there are no rows. */
  async max(column) {
    const { cell, type } = await this._aggregate(`max(${quoteIdent(column)})`);
    return cell == null ? null : decodeCell(cell, type);
  }
}

/** Base for the write builders: awaitable (thenable) so `await Model.insert(...)` runs the query. */
class Writable {
  then(onFulfilled, onRejected) {
    return this._run().then(onFulfilled, onRejected);
  }
}

class InsertBuilder extends Writable {
  constructor(model, data) {
    super();
    this.model = model;
    this.data = data;
  }

  async _run() {
    const cols = Object.keys(this.data);
    const params = cols.map((c) => this.data[c]);
    const placeholders = cols.map((_, i) => `$${i + 1}`);
    const sql =
      `INSERT INTO ${quoteIdent(this.model.table)} (${cols.map(quoteIdent).join(', ')}) ` +
      `VALUES (${placeholders.join(', ')}) RETURNING *`;
    const res = await this.model.orm.conn.query(sql, params);
    const objs = rowsToObjects(res, this.model);
    return objs.length ? objs[0] : null;
  }
}

class UpdateBuilder extends Writable {
  constructor(model, data) {
    super();
    this.model = model;
    this.data = data;
    this._where = null;
  }

  where(eq) {
    this._where = eq;
    return this;
  }

  async _run() {
    const params = [];
    const sets = Object.keys(this.data).map((c) => {
      params.push(this.data[c]);
      return `${quoteIdent(c)} = $${params.length}`;
    });
    let sql = `UPDATE ${quoteIdent(this.model.table)} SET ${sets.join(', ')}`;
    sql += buildWhere(this._where, params);
    sql += ' RETURNING *';
    const res = await this.model.orm.conn.query(sql, params);
    return rowsToObjects(res, this.model);
  }
}

class DeleteBuilder extends Writable {
  constructor(model) {
    super();
    this.model = model;
    this._where = null;
  }

  where(eq) {
    this._where = eq;
    return this;
  }

  async _run() {
    const params = [];
    let sql = `DELETE FROM ${quoteIdent(this.model.table)}`;
    sql += buildWhere(this._where, params);
    sql += ' RETURNING *';
    const res = await this.model.orm.conn.query(sql, params);
    return rowsToObjects(res, this.model);
  }
}

/** A table mapping: its name plus a `{ column: type }` map used as a decode fallback. */
class Model {
  constructor(orm, table, columns) {
    this.orm = orm;
    this.table = table;
    this.columns = columns || {};
    this.relations = {};
  }

  select() {
    return new SelectBuilder(this);
  }

  /**
   * Declare a `belongsTo` relation (NORM-v3, R43-B.01): this model's `foreignKey` references the
   * `target` model's `localKey` (default `'id'`). Eager-load it with `.select().include(name)` or
   * lazily with `model.loadRelated(rows, name)`. Returns `this` for chaining.
   */
  belongsTo(name, target, opts = {}) {
    if (!opts.foreignKey) {
      throw new Error(`belongsTo('${name}') requires { foreignKey }`);
    }
    this.relations[name] = {
      kind: 'belongsTo',
      target,
      foreignKey: opts.foreignKey,
      localKey: opts.localKey || 'id',
    };
    return this;
  }

  /**
   * Declare a `hasMany` relation (NORM-v3, R43-B.01): the `target` model's `foreignKey` references
   * this model's `localKey` (default `'id'`). The loaded value is an array. Returns `this`.
   */
  hasMany(name, target, opts = {}) {
    if (!opts.foreignKey) {
      throw new Error(`hasMany('${name}') requires { foreignKey }`);
    }
    this.relations[name] = {
      kind: 'hasMany',
      target,
      foreignKey: opts.foreignKey,
      localKey: opts.localKey || 'id',
    };
    return this;
  }

  /** Declare a `hasOne` relation (NORM-v3, R43-B.01): like `hasMany` but the value is one row or `null`. */
  hasOne(name, target, opts = {}) {
    if (!opts.foreignKey) {
      throw new Error(`hasOne('${name}') requires { foreignKey }`);
    }
    this.relations[name] = {
      kind: 'hasOne',
      target,
      foreignKey: opts.foreignKey,
      localKey: opts.localKey || 'id',
    };
    return this;
  }

  /**
   * Lazily load a declared relation onto already-fetched row(s), in place (NORM-v3, R43-B.01).
   * Accepts a single row or an array; one batched query covers them all (N+1-free). Returns the
   * same row(s) for convenience.
   */
  async loadRelated(rowsOrRow, name) {
    const rel = this.relations[name];
    if (!rel) {
      throw new Error(`unknown relation '${name}' on model '${this.table}'`);
    }
    const rows = Array.isArray(rowsOrRow) ? rowsOrRow : [rowsOrRow];
    await attachRelation(this, rel, name, rows);
    return rowsOrRow;
  }

  /** The `CREATE TABLE` SQL for this model's columns (see {@link createTable}). */
  createTableSql(options = {}) {
    const defs = [];
    const pks = [];
    for (const [name, raw] of Object.entries(this.columns)) {
      const spec = typeof raw === 'string' ? { type: raw } : raw;
      let def = `${quoteIdent(name)} ${ddlType(spec.type)}`;
      if (spec.notNull || spec.primaryKey) {
        def += ' NOT NULL';
      }
      defs.push(def);
      if (spec.primaryKey) {
        pks.push(quoteIdent(name));
      }
    }
    if (pks.length) {
      defs.push(`PRIMARY KEY (${pks.join(', ')})`);
    }
    const ifNotExists = options.ifNotExists ? 'IF NOT EXISTS ' : '';
    return `CREATE TABLE ${ifNotExists}${quoteIdent(this.table)} (${defs.join(', ')})`;
  }

  /**
   * Create the table from the model's column definitions (R&I NORM-v2). Each column is `'int'` or
   * `{ type, notNull, primaryKey }`; a `primaryKey` (or `notNull`) column is `NOT NULL`, and the
   * primary-key columns form a `PRIMARY KEY (...)`. Pass `{ ifNotExists: true }` to skip if present.
   */
  async createTable(options = {}) {
    await this.orm.conn.query(this.createTableSql(options));
  }

  /**
   * Compare the model's declared columns against the live table via `information_schema` (NORM-v3,
   * R43-B.04). Returns `{ exists, missing, extra, mismatched }`: `missing` are model columns absent
   * from the table (candidates for `ADD COLUMN`), `extra` are live columns not in the model, and
   * `mismatched` are columns whose live `data_type` differs from the model's. Only additive changes
   * are ever generated automatically (see {@link migrationPlan}); drops and type changes are
   * reported for a human to decide, since they can lose data.
   */
  async diffSchema() {
    const res = await this.orm.conn.query(
      'SELECT column_name, data_type, is_nullable FROM information_schema.columns ' +
        `WHERE table_name = ${quoteString(this.table)} ORDER BY ordinal_position`
    );
    const live = new Map();
    for (const row of res.rows) {
      live.set(String(row[0]), {
        dataType: String(row[1]).toLowerCase(),
        nullable: String(row[2]).toUpperCase() === 'YES',
      });
    }
    const missing = [];
    const mismatched = [];
    for (const [name, raw] of Object.entries(this.columns)) {
      const spec = typeof raw === 'string' ? { type: raw } : raw;
      const col = live.get(name);
      if (!col) {
        missing.push({ name, spec });
      } else if (col.dataType !== catalogType(spec.type)) {
        mismatched.push({ name, modelType: catalogType(spec.type), liveType: col.dataType });
      }
    }
    const extra = [...live.keys()].filter(
      (name) => !Object.prototype.hasOwnProperty.call(this.columns, name)
    );
    return { exists: live.size > 0, missing, extra, mismatched };
  }

  /**
   * Build the additive migration statements that bring the live table in line with the model
   * (NORM-v3, R43-B.04): a `CREATE TABLE` when the table is absent, otherwise an `ADD COLUMN` per
   * missing column. A missing `NOT NULL` column is added **nullable** on an existing table (adding a
   * `NOT NULL` column without a default would fail on a populated table); the `relaxedNotNull` list
   * names those so a follow-up backfill + constraint can be done deliberately. Drops (`diff.extra`)
   * and type changes (`diff.mismatched`) are never emitted. Returns `{ statements, diff,
   * relaxedNotNull }`.
   */
  async migrationPlan() {
    const diff = await this.diffSchema();
    const statements = [];
    const relaxedNotNull = [];
    if (!diff.exists) {
      statements.push(this.createTableSql());
    } else {
      for (const { name, spec } of diff.missing) {
        const stmt = `ALTER TABLE ${quoteIdent(this.table)} ADD COLUMN ${quoteIdent(name)} ${ddlType(spec.type)}`;
        if (spec.notNull || spec.primaryKey) {
          relaxedNotNull.push(name);
        }
        statements.push(stmt);
      }
    }
    return { statements, diff, relaxedNotNull };
  }

  /**
   * Apply the additive {@link migrationPlan} (create the table or add missing columns) and return
   * `{ applied, diff, relaxedNotNull }` where `applied` is the statements that ran. A no-op (empty
   * `applied`) when the table already matches the model's columns.
   */
  async syncSchema() {
    const { statements, diff, relaxedNotNull } = await this.migrationPlan();
    for (const stmt of statements) {
      await this.orm.conn.query(stmt);
    }
    return { applied: statements, diff, relaxedNotNull };
  }

  /** Drop the table. Pass `{ ifExists: true }` to make it a no-op when absent. */
  async dropTable(options = {}) {
    const ifExists = options.ifExists ? 'IF EXISTS ' : '';
    await this.orm.conn.query(`DROP TABLE ${ifExists}${quoteIdent(this.table)}`);
  }

  insert(data) {
    return new InsertBuilder(this, data);
  }

  update(data) {
    return new UpdateBuilder(this, data);
  }

  delete() {
    return new DeleteBuilder(this);
  }
}

/** The ORM, bound to one NusaDB connection. */
class Orm {
  constructor(conn) {
    this.conn = conn;
  }

  /** Open a connection and return an `Orm` for it. */
  static async connect(options) {
    return new Orm(await connect(options));
  }

  /** Define a model over a table. `columns` is an optional `{ name: type }` decode-fallback map. */
  model(table, columns) {
    return new Model(this, table, columns);
  }

  /** Run a raw SQL statement (escape hatch); returns the driver result. */
  raw(sql, params) {
    return this.conn.query(sql, params);
  }

  /**
   * Run `work` inside a transaction: `BEGIN`, then `COMMIT` on success or `ROLLBACK` if `work`
   * throws (the error is re-raised). `work` receives this same `Orm` (one connection).
   */
  async transaction(work) {
    await this.conn.query('BEGIN');
    try {
      const result = await work(this);
      await this.conn.query('COMMIT');
      return result;
    } catch (err) {
      await this.conn.query('ROLLBACK');
      throw err;
    }
  }

  /** Close the underlying connection. */
  async close() {
    await this.conn.close();
  }
}

/**
 * Versioned schema migrations (NORM-v3, R43-B.02). A migration is `{ version, up, down? }`: `version`
 * is a string identifier (use a sortable, non-purely-numeric form such as `'0001_create_users'` —
 * the runner applies migrations in ascending `version` order), `up(orm)` applies the change, and the
 * optional `down(orm)` reverses it. Both callbacks receive a transactional ORM, so a migration that
 * throws midway is rolled back as a unit. Applied versions are recorded in a bookkeeping table
 * (default `schema_migrations`) so `migrate()` is idempotent — already-applied migrations are
 * skipped.
 *
 * The bookkeeping table name must not start with the reserved `nusadb_` system-catalog prefix.
 */
class Migrator {
  constructor(orm, migrations, options = {}) {
    this.orm = orm;
    this.table = options.table || 'schema_migrations';
    if (/^nusadb_/i.test(this.table)) {
      throw new Error(`migration table '${this.table}' must not use the reserved 'nusadb_' prefix`);
    }
    const seen = new Set();
    for (const m of migrations || []) {
      if (!m || typeof m.version !== 'string' || m.version === '') {
        throw new Error('each migration needs a non-empty string `version`');
      }
      if (typeof m.up !== 'function') {
        throw new Error(`migration '${m.version}' needs an up() function`);
      }
      if (seen.has(m.version)) {
        throw new Error(`duplicate migration version '${m.version}'`);
      }
      seen.add(m.version);
    }
    // Apply in ascending version order, deterministically, regardless of array order.
    this.migrations = [...(migrations || [])].sort((a, b) => {
      if (a.version < b.version) return -1;
      return a.version > b.version ? 1 : 0;
    });
  }

  /** Create the bookkeeping table if absent (idempotent). */
  async _ensureTable() {
    await this.orm.conn.query(
      `CREATE TABLE IF NOT EXISTS ${quoteIdent(this.table)} ` +
        `(version TEXT NOT NULL, applied_at TEXT NOT NULL, PRIMARY KEY (version))`
    );
  }

  /** The set of already-applied versions (ensures the bookkeeping table first). */
  async _appliedVersions() {
    await this._ensureTable();
    const res = await this.orm.conn.query(`SELECT version FROM ${quoteIdent(this.table)}`);
    return new Set(res.rows.map((r) => String(r[0])));
  }

  /** Apply every pending migration in version order. Returns the versions applied this run. */
  async migrate() {
    const applied = await this._appliedVersions();
    const ran = [];
    for (const m of this.migrations) {
      if (applied.has(m.version)) {
        continue;
      }
      await this.orm.transaction(async (tx) => {
        await m.up(tx);
        await tx.conn.query(
          `INSERT INTO ${quoteIdent(this.table)} (version, applied_at) ` +
            `VALUES (${quoteString(m.version)}, ${quoteString(new Date().toISOString())})`
        );
      });
      ran.push(m.version);
    }
    return ran;
  }

  /**
   * Roll back the last `steps` applied migrations (default 1), newest first, running each `down()`.
   * Returns the versions rolled back. Throws if a migration to roll back has no `down()`.
   */
  async rollback(steps = 1) {
    const applied = await this._appliedVersions();
    const appliedInOrder = this.migrations.filter((m) => applied.has(m.version));
    const toRollback = appliedInOrder.slice(-steps).reverse();
    const done = [];
    for (const m of toRollback) {
      if (typeof m.down !== 'function') {
        throw new Error(`migration '${m.version}' has no down() — cannot roll back`);
      }
      await this.orm.transaction(async (tx) => {
        await m.down(tx);
        await tx.conn.query(
          `DELETE FROM ${quoteIdent(this.table)} WHERE version = ${quoteString(m.version)}`
        );
      });
      done.push(m.version);
    }
    return done;
  }

  /** Each known migration with whether it has been applied, in version order. */
  async status() {
    const applied = await this._appliedVersions();
    return this.migrations.map((m) => ({ version: m.version, applied: applied.has(m.version) }));
  }
}

module.exports = { Orm, Model, Migrator, quoteIdent, quoteString };
