# nusadb-orm — a native ORM / query builder for NusaDB

A small, **native** ORM for Node, built on the [`nusadb`](../README.md) driver. It speaks NusaDB's
own SQL (bare table names, `$n` parameters, a constant `LIMIT`, `RETURNING`, double-quoted
identifiers) and decodes results into typed JS values using the protocol 1.1 per-column type
metadata (`columnTypes`) the driver returns. No third-party database dialect or identity is
involved — this is NusaDB's own data-access layer.

## Usage

```js
const { Orm } = require('nusadb-orm');

const orm = await Orm.connect({ host: '127.0.0.1', port: 5678, user: 'nusa-root', database: 'nusadb' });

// A model maps a table; the type map is an optional decode fallback.
const Account = orm.model('account', { id: 'int', name: 'text', balance: 'int', active: 'bool' });

// Create — returns the inserted row, typed (numbers/booleans, not strings).
const a = await Account.insert({ id: 1, name: 'alice', balance: 100, active: true });

// Read — `all()` / `first()` / `count()`; values decoded by the server's column types.
const one = await Account.select().where({ id: 1 }).first();
const top = await Account.select().orderBy('balance', 'desc').limit(1).all();

// where operators: comparison (gt/gte/lt/lte/ne), in/notIn, like/ilike, between, isNull
// (plain value = equality); `$or`/`$and` group keys nest.
const rich = await Account.select()
  .where({ balance: { gt: 100, between: [50, 500] }, name: { ilike: 'a%' }, id: { notIn: [9] } })
  .all();
const either = await Account.select()
  .where({ $or: [{ active: true }, { balance: { gte: 100 } }] })
  .all();
const total = await Account.select().where({ active: true }).count();

// Pagination (constant LIMIT/OFFSET, inlined for the server), DISTINCT, and aggregates.
const page = await Account.select().orderBy('id').limit(10).offset(20).all();
const cities = await Account.select().distinct().columns('name').all();
const totalBalance = await Account.select().sum('balance'); // also: avg / min / max
const richest = await Account.select().max('balance');

// GROUP BY + HAVING with a raw aggregate projection.
const perFlag = await Account.select()
  .selectRaw('active', 'count(*) AS n')
  .groupBy('active')
  .having('count(*) >= ?', [2])
  .all();

// Set operations (UNION / UNION ALL / INTERSECT / EXCEPT); orderBy/limit apply to the whole.
const combined = await Account.select()
  .columns('id')
  .where({ id: 1 })
  .union(Account.select().columns('id').where({ id: 2 }))
  .orderBy('id')
  .all();

// Ad-hoc joins (raw ON fragment). Project columns to avoid name collisions across tables; for
// declared model relationships prefer `.include()` (N+1-free).
const owners = await Account.select()
  .columns('balance')
  .join('pet', '"pet"."owner_id" = "account"."id"')
  .all();

// Update / delete — `where()` then await.
await Account.update({ balance: 250 }).where({ id: 1 });
await Account.delete().where({ id: 2 });

// Transaction — COMMIT on success, ROLLBACK if the callback throws.
await orm.transaction(async (tx) => {
  await tx.model('account').insert({ id: 10, name: 'dave', balance: 5, active: true });
});

await orm.close();
```

`orm.raw(sql, params)` is an escape hatch returning the underlying driver result.

## Relations

Declare `belongsTo` / `hasMany` / `hasOne` on a model, then load related rows eagerly with
`.include(...)` or lazily with `model.loadRelated(rows, name)`. Either way each relation is fetched
with **one batched query** (`WHERE key IN (...)`), so loading is N+1-free regardless of how many
parent rows you have.

```js
const User = orm.model('app_user', { id: 'int', name: 'text' });
const Order = orm.model('app_order', { id: 'int', user_id: 'int', total: 'int' });

User.hasMany('orders', Order, { foreignKey: 'user_id' });   // localKey defaults to 'id'
User.hasOne('profile', Profile, { foreignKey: 'user_id' });
Order.belongsTo('user', User, { foreignKey: 'user_id' });

// Eager: orders/profile nested onto each user.
const users = await User.select().include('orders', 'profile').orderBy('id').all();
users[0].orders;   // [{ id, user_id, total }, ...] — typed
users[0].profile;  // one row or null (hasOne)

// belongsTo from the other side.
const orders = await Order.select().include('user').all();
orders[0].user;    // the parent user, or null

// Lazy: load onto rows you already have (single row or array).
const bob = await User.select().where({ id: 2 }).first();
await User.loadRelated(bob, 'orders');   // bob.orders now populated
```

A `hasMany` value is an array; `hasOne` / `belongsTo` is a single row or `null`. Relations are
loaded with separate batched queries rather than a `JOIN`, which avoids duplicate-column collisions
(`SELECT *` across tables) and cartesian blow-up from multiple `hasMany` includes.

## Typed results

Each returned row is a plain object whose values are decoded from the server's column types:
`FLOAT` → JS number, `BOOL` → boolean, everything else (`TEXT`, `NUMERIC`, `DATE`, `TIME`,
`TIMESTAMP`, `JSON`, `UUID`, …) → its text rendering. The model's `{ name: type }` map is a fallback
used only when the server does not report a column's type.

`INT` is 64-bit: a value within JS's safe-integer range (±2⁵³) decodes to a **number**, and a larger
value decodes to a **BigInt** so no precision is lost. Typical ids and counters stay plain numbers;
only genuinely 64-bit values become BigInt.

## Schema (DDL)

A model can create and drop its own table. Columns are `'int'` or
`{ type, notNull, primaryKey }`; a `primaryKey`/`notNull` column is `NOT NULL`, and primary-key
columns form a `PRIMARY KEY (...)`.

```js
const Account = orm.model('account', {
  id: { type: 'int', primaryKey: true },
  name: { type: 'text', notNull: true },
  balance: 'int',
});
await Account.createTable();              // or { ifNotExists: true }
await Account.dropTable({ ifExists: true });
```

## Migrations

Versioned schema migrations with up/down and a runner. A migration is `{ version, up, down }`;
applied versions are recorded in a bookkeeping table (default `schema_migrations`) so `migrate()` is
idempotent. Migrations run in ascending `version` order — use a sortable, **non-purely-numeric**
identifier such as `'0001_create_users'`.

```js
const { Orm, Migrator } = require('nusadb-orm');

const migrations = [
  {
    version: '0001_create_users',
    async up(m)   { await m.raw('CREATE TABLE users (id INT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (id))'); },
    async down(m) { await m.raw('DROP TABLE users'); },
  },
  {
    version: '0002_seed_admin',
    async up(m)   { await m.raw('INSERT INTO users (id, name) VALUES ($1, $2)', [1, 'admin']); },
    async down(m) { await m.raw('DELETE FROM users WHERE id = $1', [1]); },
  },
];

const migrator = new Migrator(orm, migrations);   // or { table: 'my_migrations' }
await migrator.migrate();        // apply all pending → ['0001_create_users', '0002_seed_admin']
await migrator.status();         // [{ version, applied }, ...]
await migrator.rollback();       // roll back the last applied (or rollback(n) for the last n)
```

Each `up`/`down` runs inside a transaction (it receives a transactional ORM), so a migration that
throws partway is rolled back as a unit. The bookkeeping table must not use the reserved `nusadb_`
prefix; the version is written as a quoted string literal so all-digit identifiers keep their exact
text (a bound parameter would be type-inferred as an integer).

### Schema auto-diff

A model can compare its declared columns against the live table (via `information_schema`) and
generate the **additive** statements to bring the table in line — useful for authoring a migration
or syncing a dev database:

```js
const Users = orm.model('app_user', {
  id: { type: 'int', primaryKey: true },
  name: { type: 'text', notNull: true },
  email: 'text',           // newly added to the model
});

const diff = await Users.diffSchema();
// { exists, missing: [{ name: 'email', spec }], extra: [], mismatched: [] }

const plan = await Users.migrationPlan();
// { statements: ['ALTER TABLE "app_user" ADD COLUMN "email" TEXT'], diff, relaxedNotNull: [] }

await Users.syncSchema();  // applies the plan (CREATE TABLE if absent, else ADD COLUMN per missing)
```

Only **additive** changes are generated: a `CREATE TABLE` when the table is absent, or an
`ADD COLUMN` per missing column. Dropped columns (`diff.extra`) and type changes (`diff.mismatched`)
are **reported, never applied** — they can lose data, so they are left for a human to handle. A
missing `NOT NULL` column is added nullable on an existing table (a `NOT NULL` add would fail on a
populated table) and named in `relaxedNotNull` for a deliberate backfill.

## Scope

`model()`, `select()` (`where` with comparison/`in`/`notIn`/`like`/`ilike`/`between`/`isNull` operators
and `$or`/`$and` groups, `columns`/`selectRaw`, `distinct`, `join`/`leftJoin`/`rightJoin`/`fullJoin`/
`crossJoin`, `groupBy`/`having`, `orderBy`, `limit`/`offset`, set ops `union`/`unionAll`/`intersect`/
`except`, `all`, `first`, `count`, `sum`/`avg`/`min`/`max`), `insert()`, `update().where()`,
`delete().where()`, `createTable()` /
`dropTable()`, `transaction()`, `raw()`, relations (`belongsTo`/`hasMany`/`hasOne` with eager
`.include()` / lazy `loadRelated()`), `Migrator` (versioned `migrate`/`rollback`/`status`), schema
auto-diff (`diffSchema`/`migrationPlan`/`syncSchema`), and generic TypeScript declarations. NusaDB
has no auto-increment, so use application-assigned ids.

The native ORM roadmap (`info/Research_Result/nusadb_norm_v3_roadmap.md`) is complete; only
non-additive schema changes (column drops / type changes) are deliberately left to hand-written
migrations.

## TypeScript

The package ships type declarations (`index.d.ts`). Models are generic over a row shape, so reads,
writes, and `where` clauses are typed:

```ts
import { Orm, Migrator } from 'nusadb-orm';

interface User { id: number; name: string; active: boolean }

const orm = await Orm.connect({ host: '127.0.0.1', port: 5678, user: 'app', database: 'nusadb' });
const Users = orm.model<User>('app_user');

const rows: User[] = await Users.select().where({ active: true }).all();
const one: User | null = await Users.select().where({ id: 1 }).first();
const created: User | null = await Users.insert({ id: 1, name: 'alice', active: true });
```

`where` keys are checked against the row's columns and accept either a value (equality) or an
operator object (`{ gt }`, `{ in }`, `{ like }`, …). The declarations are runtime-free — they add
no behavior. A type-level test lives in `types-test.ts`; `npm run typecheck` compiles it with `tsc`
(eagerly-loaded relations attach as `unknown`-typed members, since the row shape does not name them).

## Build & test

```bash
cargo build -p nusadb-server          # the test boots a real server
node drivers/node/orm/test.js
```

`test.js` boots a real `nusadb-server` and exercises insert, typed select/first, an ordered select
with limit, update, delete, a committed + rolled-back transaction, where-operators/count/DDL,
relations (eager `include` + lazy `loadRelated` for `belongsTo`/`hasMany`/`hasOne`), migrations
(`migrate`/`rollback`/idempotent/`status`), and schema auto-diff (`diffSchema`/`syncSchema`).

## License

Apache-2.0.
