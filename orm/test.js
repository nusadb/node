'use strict';

// Integration test for nusadb-orm against a real nusadb-server.
// Run after `cargo build -p nusadb-server`:  node drivers/node/orm/test.js

const assert = require('assert');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const { Orm, Migrator } = require('./index');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function serverBinary() {
  const bases = [];
  if (process.env.CARGO_TARGET_DIR) bases.push(process.env.CARGO_TARGET_DIR);
  bases.push(path.join(REPO_ROOT, 'target'));
  const names = process.platform === 'win32' ? ['nusadb-server.exe'] : ['nusadb-server'];
  for (const base of bases) {
    for (const profile of ['debug', 'release']) {
      for (const name of names) {
        const p = path.join(base, profile, name);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function waitReady(port, deadlineMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const sock = net.connect({ host: '127.0.0.1', port }, () => {
        sock.destroy();
        resolve();
      });
      sock.on('error', () => {
        sock.destroy();
        if (Date.now() - start > deadlineMs) reject(new Error('server not ready'));
        else setTimeout(tryOnce, 100);
      });
    };
    tryOnce();
  });
}

async function startServer() {
  const bin = serverBinary();
  if (!bin) {
    console.log('SKIP: nusadb-server binary not found; run `cargo build -p nusadb-server`');
    process.exit(0);
  }
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nusadb-orm-'));
  const child = spawn(bin, ['--listen', `127.0.0.1:${port}`, '--data-dir', dir], {
    stdio: 'ignore',
    env: { ...process.env, RUST_LOG: 'error' },
  });
  await waitReady(port);
  return {
    port,
    stop() {
      child.kill();
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (_e) {
        // ignore
      }
    },
  };
}

let passed = 0;
let failed = 0;
async function run(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL - ${name}\n      ${err && err.stack ? err.stack : err}`);
  }
}

(async () => {
  const server = await startServer();
  const orm = await Orm.connect({ port: server.port, user: 'u', database: 'nusadb' });

  // Define the model with column constraints and create the table from it (NORM-v2 DDL).
  const Account = orm.model('account', {
    id: { type: 'int', primaryKey: true },
    name: { type: 'text', notNull: true },
    balance: 'int',
    active: { type: 'bool', notNull: true },
  });
  await Account.createTable();

  await run('insert returns the typed row', async () => {
    const a = await Account.insert({ id: 1, name: 'alice', balance: 100, active: true });
    assert.strictEqual(a.id, 1);
    assert.strictEqual(a.name, 'alice');
    assert.strictEqual(a.balance, 100);
    assert.strictEqual(a.active, true);
  });

  await run('64-bit INT decodes losslessly (R42-B.04)', async () => {
    // 2^53 + 1 is not representable as a JS number; it must come back as an exact BigInt.
    const big = 9007199254740993n;
    await orm.raw('CREATE TABLE big_int (id INT NOT NULL, n INT NOT NULL)');
    const Big = orm.model('big_int', { id: 'int', n: 'int' });
    await Big.insert({ id: 1, n: big });
    const row = await Big.select().where({ id: 1 }).first();
    assert.strictEqual(typeof row.n, 'bigint');
    assert.strictEqual(row.n, big);
    // A small INT stays an ergonomic plain number.
    assert.strictEqual(typeof row.id, 'number');
    assert.strictEqual(row.id, 1);
  });

  await run('select where + first (typed decode)', async () => {
    const a = await Account.select().where({ id: 1 }).first();
    assert.strictEqual(a.balance, 100); // number, not "100"
    assert.strictEqual(a.active, true); // boolean, not "true"
  });

  await run('ordered select with limit', async () => {
    await Account.insert({ id: 2, name: 'bob', balance: 50, active: false });
    await Account.insert({ id: 3, name: 'carol', balance: 75, active: true });
    const top = await Account.select().orderBy('balance', 'desc').limit(1).all();
    assert.strictEqual(top.length, 1);
    assert.strictEqual(top[0].name, 'alice');
    const all = await Account.select().orderBy('id').all();
    assert.deepStrictEqual(all.map((r) => r.id), [1, 2, 3]);
  });

  await run('limit + offset paginates', async () => {
    // ids 1,2,3 present (alice/bob/carol); page past the first row.
    const page = await Account.select().orderBy('id').limit(2).offset(1).all();
    assert.deepStrictEqual(page.map((r) => r.id), [2, 3]);
    const skipAll = await Account.select().orderBy('id').offset(3).all();
    assert.strictEqual(skipAll.length, 0);
  });

  await run('distinct collapses duplicate rows', async () => {
    const flags = await Account.select().distinct().columns('active').orderBy('active').all();
    assert.deepStrictEqual(flags.map((r) => r.active), [false, true]);
  });

  await run('aggregates: sum / avg / min / max (honour where)', async () => {
    // balances: alice 100, bob 50, carol 75.
    assert.strictEqual(await Account.select().sum('balance'), 225);
    assert.strictEqual(await Account.select().avg('balance'), 75);
    assert.strictEqual(await Account.select().min('balance'), 50);
    assert.strictEqual(await Account.select().max('balance'), 100);
    assert.strictEqual(await Account.select().where({ active: true }).sum('balance'), 175);
    assert.strictEqual(await Account.select().where({ id: { gt: 99 } }).sum('balance'), null);
  });

  await run('inner join with projected columns', async () => {
    const Pet = orm.model('pet', {
      id: { type: 'int', primaryKey: true },
      owner_id: 'int',
      name: 'text',
    });
    await Pet.createTable();
    await Pet.insert({ id: 1, owner_id: 1, name: 'rex' });
    await Pet.insert({ id: 2, owner_id: 3, name: 'whiskers' });
    await Pet.insert({ id: 3, owner_id: 99, name: 'orphan' });

    // Project unambiguous columns only (`balance` lives on account, `owner_id` on pet) — both
    // tables also share `id`/`name`, which would be ambiguous if selected unqualified.
    const joined = await Pet.select()
      .columns('owner_id', 'balance')
      .join('account', '"pet"."owner_id" = "account"."id"')
      .orderBy('balance')
      .all();
    assert.deepStrictEqual(
      joined.map((r) => [r.owner_id, r.balance]),
      [
        [3, 75],
        [1, 100],
      ]
    );

    // LEFT JOIN keeps the orphan pet (owner_id 99 has no account row).
    const left = await Pet.select()
      .columns('owner_id')
      .leftJoin('account', '"pet"."owner_id" = "account"."id"')
      .orderBy('owner_id')
      .all();
    assert.deepStrictEqual(left.map((r) => r.owner_id), [1, 3, 99]);

    await Pet.dropTable();
  });

  await run('where operators: notIn / ilike / between / $or', async () => {
    // accounts: 1 alice/100/true, 2 bob/50/false, 3 carol/75/true.
    const notIn = await Account.select().where({ id: { notIn: [2] } }).orderBy('id').all();
    assert.deepStrictEqual(notIn.map((r) => r.id), [1, 3]);
    const ilike = await Account.select().where({ name: { ilike: 'A%' } }).all();
    assert.deepStrictEqual(ilike.map((r) => r.name), ['alice']);
    const between = await Account.select()
      .where({ balance: { between: [60, 100] } })
      .orderBy('id')
      .all();
    assert.deepStrictEqual(between.map((r) => r.id), [1, 3]);
    const ored = await Account.select()
      .where({ $or: [{ id: 1 }, { name: 'carol' }] })
      .orderBy('id')
      .all();
    assert.deepStrictEqual(ored.map((r) => r.id), [1, 3]);
  });

  await run('groupBy + having with selectRaw aggregate', async () => {
    // active=true has 2 rows (alice, carol), active=false has 1 (bob).
    const groups = await Account.select()
      .selectRaw('active', 'count(*) AS n')
      .groupBy('active')
      .having('count(*) >= ?', [2])
      .all();
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].active, true);
    assert.strictEqual(groups[0].n, 2);
  });

  await run('set operations: union / except', async () => {
    const unioned = await Account.select()
      .columns('id')
      .where({ id: 1 })
      .union(Account.select().columns('id').where({ id: 2 }))
      .orderBy('id')
      .all();
    assert.deepStrictEqual(unioned.map((r) => r.id), [1, 2]);

    const excepted = await Account.select()
      .columns('id')
      .where({ id: { in: [1, 2, 3] } })
      .except(Account.select().columns('id').where({ id: 2 }))
      .orderBy('id')
      .all();
    assert.deepStrictEqual(excepted.map((r) => r.id), [1, 3]);
  });

  await run('update', async () => {
    await Account.update({ balance: 250 }).where({ id: 1 });
    const a = await Account.select().where({ id: 1 }).first();
    assert.strictEqual(a.balance, 250);
  });

  await run('delete', async () => {
    await Account.delete().where({ id: 2 });
    assert.strictEqual(await Account.select().where({ id: 2 }).first(), null);
    assert.notStrictEqual(await Account.select().where({ id: 3 }).first(), null);
  });

  await run('transaction commit + rollback', async () => {
    await orm.transaction(async (tx) => {
      await tx.model('account').insert({ id: 10, name: 'dave', balance: 5, active: true });
    });
    assert.notStrictEqual(await Account.select().where({ id: 10 }).first(), null);

    await assert.rejects(
      orm.transaction(async (tx) => {
        await tx.model('account').insert({ id: 99, name: 'ghost', balance: 0, active: false });
        throw new Error('force rollback');
      })
    );
    assert.strictEqual(await Account.select().where({ id: 99 }).first(), null);
  });

  await run('NORM-v2: where operators + count + DDL', async () => {
    const Item = orm.model('item', {
      id: { type: 'int', primaryKey: true },
      name: { type: 'text', notNull: true },
      qty: 'int',
    });
    await Item.createTable();
    await Item.insert({ id: 1, name: 'apple', qty: 10 });
    await Item.insert({ id: 2, name: 'avocado', qty: 5 });
    await Item.insert({ id: 3, name: 'banana', qty: null });

    const gt = await Item.select().where({ qty: { gt: 6 } }).all();
    assert.deepStrictEqual(gt.map((r) => r.id), [1]);

    const inq = await Item.select().where({ id: { in: [1, 3] } }).orderBy('id').all();
    assert.deepStrictEqual(inq.map((r) => r.id), [1, 3]);

    const like = await Item.select().where({ name: { like: 'a%' } }).orderBy('id').all();
    assert.deepStrictEqual(like.map((r) => r.name), ['apple', 'avocado']);

    const missing = await Item.select().where({ qty: { isNull: true } }).all();
    assert.deepStrictEqual(missing.map((r) => r.id), [3]);

    assert.strictEqual(await Item.select().count(), 3);
    assert.strictEqual(await Item.select().where({ qty: { isNull: false } }).count(), 2);

    await Item.dropTable();
    await assert.rejects(Item.select().all(), 'table is gone after dropTable');
  });

  await run('NORM-v3: relations (belongsTo / hasMany / hasOne, eager + lazy)', async () => {
    const User = orm.model('app_user', {
      id: { type: 'int', primaryKey: true },
      name: { type: 'text', notNull: true },
    });
    const Order = orm.model('app_order', {
      id: { type: 'int', primaryKey: true },
      user_id: { type: 'int', notNull: true },
      total: 'int',
    });
    const Profile = orm.model('app_profile', {
      id: { type: 'int', primaryKey: true },
      user_id: { type: 'int', notNull: true },
      bio: 'text',
    });
    await User.createTable();
    await Order.createTable();
    await Profile.createTable();

    // A user has many orders and one profile; an order belongs to a user.
    User.hasMany('orders', Order, { foreignKey: 'user_id' });
    User.hasOne('profile', Profile, { foreignKey: 'user_id' });
    Order.belongsTo('user', User, { foreignKey: 'user_id' });

    await User.insert({ id: 1, name: 'alice' });
    await User.insert({ id: 2, name: 'bob' });
    await Profile.insert({ id: 1, user_id: 1, bio: 'hi' });
    await Order.insert({ id: 1, user_id: 1, total: 30 });
    await Order.insert({ id: 2, user_id: 1, total: 70 });
    await Order.insert({ id: 3, user_id: 2, total: 5 });

    // Eager hasMany: each user's orders nested correctly, no cross-user leakage.
    const users = await User.select().include('orders', 'profile').orderBy('id').all();
    assert.deepStrictEqual(users.map((u) => u.id), [1, 2]);
    assert.deepStrictEqual(users[0].orders.map((o) => o.id).sort(), [1, 2]);
    assert.deepStrictEqual(users[1].orders.map((o) => o.id), [3]);
    // hasMany values are typed (total decoded to number, not string).
    assert.strictEqual(users[0].orders[0].total, users[0].orders[0].id === 1 ? 30 : 70);

    // Eager hasOne: one row or null.
    assert.strictEqual(users[0].profile.bio, 'hi');
    assert.strictEqual(users[1].profile, null);

    // Eager belongsTo: each order carries its parent user.
    const orders = await Order.select().include('user').orderBy('id').all();
    assert.deepStrictEqual(orders.map((o) => o.user.name), ['alice', 'alice', 'bob']);

    // Lazy load onto an already-fetched row (single + array), via the same batched path.
    const bob = await User.select().where({ id: 2 }).first();
    assert.strictEqual(bob.orders, undefined); // not loaded until asked
    await User.loadRelated(bob, 'orders');
    assert.deepStrictEqual(bob.orders.map((o) => o.id), [3]);

    const onlyOrders = await Order.select().orderBy('id').all();
    await Order.loadRelated(onlyOrders, 'user');
    assert.deepStrictEqual(onlyOrders.map((o) => o.user.id), [1, 1, 2]);

    // Unknown relation is a clear error.
    await assert.rejects(User.select().include('nope').all(), /unknown relation 'nope'/);

    await Order.dropTable();
    await Profile.dropTable();
    await User.dropTable();
  });

  await run('NORM-v3: migrations (migrate / rollback / idempotent / status)', async () => {
    // Numeric-looking versions exercise the leading-zero preservation (quoted-literal bookkeeping).
    const migrations = [
      {
        version: '001_create_widget',
        async up(m) {
          await m.raw('CREATE TABLE widget (id INT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (id))');
        },
        async down(m) {
          await m.raw('DROP TABLE widget');
        },
      },
      {
        version: '002_seed_widget',
        async up(m) {
          await m.raw('INSERT INTO widget (id, name) VALUES ($1, $2)', [1, 'gadget']);
        },
        async down(m) {
          await m.raw('DELETE FROM widget WHERE id = $1', [1]);
        },
      },
    ];
    const migrator = new Migrator(orm, migrations);

    // Reserved-prefix table name is rejected up front.
    assert.throws(() => new Migrator(orm, [], { table: 'nusadb_x' }), /reserved 'nusadb_' prefix/);

    // First run applies both, in order.
    const ran = await migrator.migrate();
    assert.deepStrictEqual(ran, ['001_create_widget', '002_seed_widget']);
    const seeded = await orm.model('widget').select().all();
    assert.deepStrictEqual(seeded.map((r) => r.name), ['gadget']);

    // Versions preserved exactly (leading zeros) in the bookkeeping table.
    const recorded = await orm.raw('SELECT version FROM schema_migrations ORDER BY version');
    assert.deepStrictEqual(recorded.rows.map((r) => r[0]), ['001_create_widget', '002_seed_widget']);

    // Idempotent: re-running applies nothing.
    assert.deepStrictEqual(await migrator.migrate(), []);

    // Status reflects all-applied.
    assert.deepStrictEqual(await migrator.status(), [
      { version: '001_create_widget', applied: true },
      { version: '002_seed_widget', applied: true },
    ]);

    // Roll back the last one (the seed): row gone, table remains, version record removed.
    assert.deepStrictEqual(await migrator.rollback(), ['002_seed_widget']);
    assert.strictEqual(await orm.model('widget').select().count(), 0);
    assert.deepStrictEqual(await migrator.status(), [
      { version: '001_create_widget', applied: true },
      { version: '002_seed_widget', applied: false },
    ]);

    // Re-migrate reapplies only the rolled-back one.
    assert.deepStrictEqual(await migrator.migrate(), ['002_seed_widget']);
    assert.strictEqual(await orm.model('widget').select().count(), 1);

    // Roll back everything (steps covering all), newest first, then clean up.
    assert.deepStrictEqual(await migrator.rollback(2), ['002_seed_widget', '001_create_widget']);
    await assert.rejects(orm.model('widget').select().all(), 'widget table dropped by down()');
    await orm.raw('DROP TABLE schema_migrations');
  });

  await run('NORM-v3: schema auto-diff (diffSchema / migrationPlan / syncSchema)', async () => {
    const Thing = orm.model('thing', {
      id: { type: 'int', primaryKey: true },
      name: { type: 'text', notNull: true },
      qty: 'int',
    });

    // Table absent → plan is a single CREATE TABLE; syncSchema creates it.
    const plan0 = await Thing.migrationPlan();
    assert.strictEqual(plan0.diff.exists, false);
    assert.strictEqual(plan0.statements.length, 1);
    assert.match(plan0.statements[0], /^CREATE TABLE "thing"/);
    const sync0 = await Thing.syncSchema();
    assert.deepStrictEqual(sync0.applied, plan0.statements);
    await Thing.insert({ id: 1, name: 'a', qty: 5 });

    // No drift now → diff clean, plan empty, sync a no-op.
    const diff1 = await Thing.diffSchema();
    assert.strictEqual(diff1.exists, true);
    assert.deepStrictEqual(diff1.missing, []);
    assert.deepStrictEqual(diff1.extra, []);
    assert.deepStrictEqual(diff1.mismatched, []);
    assert.deepStrictEqual((await Thing.syncSchema()).applied, []);

    // Extend the model with new columns (one NOT NULL) → diff reports them missing, plan ADDs them.
    const Thing2 = orm.model('thing', {
      id: { type: 'int', primaryKey: true },
      name: { type: 'text', notNull: true },
      qty: 'int',
      color: 'text',
      weight: { type: 'int', notNull: true },
    });
    const diff2 = await Thing2.diffSchema();
    assert.deepStrictEqual(diff2.missing.map((m) => m.name).sort(), ['color', 'weight']);
    const plan2 = await Thing2.migrationPlan();
    assert.strictEqual(plan2.statements.length, 2);
    assert.ok(plan2.statements.every((s) => /^ALTER TABLE "thing" ADD COLUMN/.test(s)));
    // The NOT NULL column is relaxed to nullable on the existing table, and reported.
    assert.deepStrictEqual(plan2.relaxedNotNull, ['weight']);
    assert.ok(!plan2.statements.some((s) => /NOT NULL/.test(s)));

    const sync2 = await Thing2.syncSchema();
    assert.strictEqual(sync2.applied.length, 2);
    // Columns now present; the row survived and reads back with NULLs for the new columns.
    const row = await Thing2.select().where({ id: 1 }).first();
    assert.strictEqual(row.color, null);
    assert.strictEqual(row.weight, null);
    assert.deepStrictEqual((await Thing2.diffSchema()).missing, []);

    // A column dropped from the model is reported as extra, never auto-dropped.
    const Thing3 = orm.model('thing', { id: { type: 'int', primaryKey: true }, name: 'text' });
    const diff3 = await Thing3.diffSchema();
    assert.deepStrictEqual(diff3.extra.sort(), ['color', 'qty', 'weight']);
    assert.deepStrictEqual((await Thing3.migrationPlan()).statements, []); // additive-only: no drops

    // A type change is reported as a mismatch, never auto-altered.
    const Thing4 = orm.model('thing', { id: { type: 'int', primaryKey: true }, name: 'int' });
    const diff4 = await Thing4.diffSchema();
    assert.deepStrictEqual(
      diff4.mismatched.map((m) => [m.name, m.liveType, m.modelType]),
      [['name', 'text', 'int']]
    );

    await Thing.dropTable();
  });

  await orm.close();
  server.stop();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
