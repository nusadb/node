# nusadb — Node.js / TypeScript driver for NusaDB

A zero-dependency Node.js driver (with first-class TypeScript typings) that speaks
the [Nusa Wire Protocol](../../docs/wire-protocol.md) (`PROTOCOL_VERSION 1.1`)
directly over a socket. SCRAM-SHA-256 uses Node's built-in `crypto`.

## Install

```bash
npm install nusadb
```

Requires Node 16+.

## Usage

```js
const { connect } = require('nusadb');

(async () => {
  const conn = await connect({ host: '127.0.0.1', port: 5678, user: 'nusa-root', database: 'nusadb' });

  await conn.query('CREATE TABLE t (id INT NOT NULL, name TEXT)');
  await conn.query('INSERT INTO t VALUES ($1, $2)', [1, 'alice']);

  const res = await conn.query('SELECT id, name FROM t WHERE id = $1', [1]);
  console.log(res.rows);        // [[1, 'alice']]  (INT -> number, TEXT -> string)
  console.log(res.columns);     // ['id', 'name']
  console.log(res.columnTypes); // ['INT', 'TEXT']  (protocol 1.1 typed metadata)

  await conn.close();
})();
```

### Column types

The driver negotiates protocol `minor = 1`, so `query()` returns `columnTypes`
alongside `columns` — a canonical type name per column (`'INT'`, `'TEXT'`,
`'BOOL'`, `'TIMESTAMP'`, `'NUMERIC'`, …; see `wire-protocol.md` §9.2). Against a
1.0 server (which has no typed metadata) every entry is `null`.

`query()` decodes each cell to its natural JS type by that tag, following mainstream Node SQL driver
conventions:

| NusaDB type | JS type |
| --- | --- |
| `BOOL` | `boolean` |
| `INT` | `number` (a 64-bit value beyond `Number.MAX_SAFE_INTEGER` becomes a `BigInt`, lossless) |
| `FLOAT` | `number` |
| `DATE` / `TIMESTAMP` / `TIMESTAMPTZ` | `Date` |
| `JSON` | parsed object |
| `ARRAY` | `Array` (elements stay strings — the wire array tag carries no element type) |
| `BYTEA` | `Buffer` (and a `Buffer` parameter binds as the `\x<hex>` form the server coerces into BYTEA) |
| `NUMERIC` / `UUID` / `TIME` / `TIMETZ` / `INTERVAL` / `TEXT` | `string` (no lossless native JS type) |

A value that does not parse as its tag falls back to the raw string, so an unexpected wire form
never throws mid-decode. Against a 1.0 (untyped) server every column stays a string.

TypeScript typings ship in `src/index.d.ts`:

```ts
import { connect, QueryResult } from 'nusadb';
const conn = await connect({ port: 5678, user: 'nusa-root', database: 'nusadb' });
const res: QueryResult = await conn.query('SELECT 1');
```

### Parameters

Placeholders are positional **`$1`, `$2`, …**. Pass values as the second argument;
`null` is SQL `NULL`. Values are sent in the wire text format. Result cells are
returned as strings (`null` for SQL NULL).

### Prepared statements

```js
const stmt = await conn.prepare('INSERT INTO t VALUES ($1, $2)');
await stmt.execute([1, 'a']);
await stmt.execute([2, 'b']);
```

### Batch (bulk insert/update)

`conn.executeMany(sql, paramSets)` runs one statement once per parameter set, reusing a single
prepared statement. It returns `{ rowCount, counts }` (`counts[i]` is the i-th set's affected-row
count). The wire protocol has no batch pipeline, so this is N round-trips, not one.

```js
const { rowCount } = await conn.executeMany('INSERT INTO t VALUES ($1, $2)', [
  [1, 'a'],
  [2, 'b'],
  [3, 'c'],
]);
```

### Bulk load / export (`COPY`)

For high-throughput load/export, `copyIn` / `copyOut` drive the `COPY` sub-protocol — one round-trip
for the whole dataset. Move bytes in the server's text format (tab-delimited fields, `\N` for SQL
`NULL`, one row per line); you write the `COPY` statement with any `WITH (...)` options.

```js
// Bulk load from a Buffer or string.
const loaded = await conn.copyIn('COPY t (id, name) FROM STDIN', '1\talice\n2\t\\N\n');

// Bulk export: resolves to { rowCount, data } (data is a Buffer).
const { rowCount, data } = await conn.copyOut('COPY t TO STDOUT');
```

A `COPY` the server refuses (bad SQL, an RLS-protected table) rejects; the connection stays usable.

### Pool

```js
const { Pool } = require('nusadb');
const pool = new Pool({ maxSize: 10, port: 5678, user: 'nusa-root', database: 'nusadb' });
await pool.withConnection((c) => c.query('SELECT 1'));
```

### Authentication & TLS

Pass `password` for a server started with `--auth-user`; the driver runs
SCRAM-SHA-256 and verifies the server signature (mutual auth). Pass `tls` (options
forwarded to `tls.connect`) for an implicit TLS 1.3 connection.

## Transactions

By default the connection is in **autocommit** mode: the server runs each statement
on its own implicit transaction. Pass `autocommit: false` for the standard
transactional model — the driver sends `BEGIN` lazily before the first statement,
and `commit()` / `rollback()` end the transaction:

```js
const conn = await connect({ port, user: 'u', database: 'nusadb', autocommit: false });
await conn.query("INSERT INTO t VALUES (1, 'alice')");
await conn.rollback();   // the insert is discarded
await conn.query("INSERT INTO t VALUES (2, 'bob')");
await conn.commit();     // this one persists
```

Inside a transaction, `savepoint(name)` marks a point you can later undo to with
`rollbackToSavepoint(name)` (the transaction stays open) or forget with `releaseSavepoint(name)`:

```js
await conn.query("INSERT INTO t VALUES (1, 'alice')");
await conn.savepoint('sp1');
await conn.query("INSERT INTO t VALUES (2, 'bob')");
await conn.rollbackToSavepoint('sp1'); // undoes (2), keeps (1); the transaction continues
await conn.commit();
```

## Notifications (LISTEN/NOTIFY)

`listen(channel)` subscribes the connection; a `notify(channel, payload)` from any connection on the
same database is then delivered asynchronously. Collect delivered notifications with `poll(timeoutMs)`
(`0` polls without blocking, `null` blocks) or drain the ones buffered during other queries with
`notifications()`:

```js
await conn.listen('orders');
// ... elsewhere: await other.notify('orders', '42');
const note = await conn.poll(5000); // -> { pid, channel, payload }, or null on timeout
console.log(note.channel, note.payload);
await conn.unlisten('orders');
```

## Tests

```bash
cargo build -p nusadb-server
node drivers/node/test/test.js
```

The tests boot a real `nusadb-server` (ephemeral port, honouring
`CARGO_TARGET_DIR`) and cover simple/parameterised/prepared queries, errors, the
pool, and SCRAM auth.

## License

Apache-2.0.
