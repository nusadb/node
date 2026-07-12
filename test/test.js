'use strict';

// Integration tests for the nusadb Node driver against a real server.
// Run: node drivers/node/test/test.js  (after `cargo build -p nusadb-server`).

const assert = require('assert');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const { connect, Pool, NusaError } = require('../src/index');

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

async function startServer(extraArgs = []) {
  const bin = serverBinary();
  if (!bin) {
    console.log('SKIP: nusadb-server binary not found; run `cargo build -p nusadb-server`');
    process.exit(0);
  }
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nusadb-node-'));
  const child = spawn(bin, ['--listen', `127.0.0.1:${port}`, '--data-dir', dir, ...extraArgs], {
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

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('simple query round trip', async (server) => {
  const conn = await connect({ port: server.port, user: 'u', database: 'nusadb' });
  await conn.query('CREATE TABLE node_simple (id INT NOT NULL, name TEXT)');
  const ins = await conn.query("INSERT INTO node_simple VALUES (5, 'alice')");
  assert.strictEqual(ins.rowCount, 1);
  const res = await conn.query('SELECT id, name FROM node_simple');
  assert.deepStrictEqual(res.columns, ['id', 'name']);
  // INT decodes to a JS number (type fidelity), TEXT stays a string.
  assert.deepStrictEqual(res.rows, [[5, 'alice']]);
  await conn.close();
});

test('typed column metadata (protocol 1.1)', async (server) => {
  const conn = await connect({ port: server.port, user: 'u', database: 'nusadb' });
  await conn.query(
    'CREATE TABLE node_typed (id INT NOT NULL, name TEXT, ok BOOL, created TIMESTAMP)'
  );
  const res = await conn.query('SELECT id, name, ok, created FROM node_typed');
  assert.deepStrictEqual(res.columns, ['id', 'name', 'ok', 'created']);
  // The driver negotiates minor=1, so the 1.1 server returns per-column type tags.
  assert.deepStrictEqual(res.columnTypes, ['INT', 'TEXT', 'BOOL', 'TIMESTAMP']);
  await conn.close();
});

test('typed value decoding', async (server) => {
  const conn = await connect({ port: server.port, user: 'u', database: 'nusadb' });
  await conn.query(
    'CREATE TABLE node_decode (b BOOL, i INT, f FLOAT, n NUMERIC(10,2), d DATE, ts TIMESTAMP, '
      + 'u UUID, j JSON, arr INT[])'
  );
  await conn.query(
    "INSERT INTO node_decode VALUES (true, 42, 1.5, 12.34, DATE '2024-01-15', "
      + "TIMESTAMP '2024-01-15 10:30:00', UUID '00000000-0000-0000-0000-000000000001', "
      + "JSON '{\"k\": 1}', ARRAY[1, 2, 3])"
  );
  const res = await conn.query('SELECT b, i, f, n, d, ts, u, j, arr FROM node_decode');
  const [b, i, f, n, d, ts, u, j, arr] = res.rows[0];
  assert.strictEqual(b, true);
  assert.strictEqual(i, 42);
  assert.strictEqual(f, 1.5);
  // NUMERIC and UUID stay strings (no lossless native JS type), as mainstream drivers do.
  assert.strictEqual(n, '12.34');
  assert.strictEqual(u, '00000000-0000-0000-0000-000000000001');
  assert.ok(d instanceof Date, 'DATE decodes to a Date');
  assert.ok(ts instanceof Date && ts.getTime() === new Date('2024-01-15T10:30:00').getTime());
  assert.deepStrictEqual(j, { k: 1 });
  // An array decodes to a JS array; elements stay strings (the wire array tag carries no element type).
  assert.deepStrictEqual(arr, ['1', '2', '3']);
  await conn.close();
});

test('NULL values decode to null', async (server) => {
  const conn = await connect({ port: server.port, user: 'u', database: 'nusadb' });
  await conn.query('CREATE TABLE node_decode_null (b BOOL, i INT, d DATE, arr INT[])');
  await conn.query('INSERT INTO node_decode_null VALUES (NULL, NULL, NULL, NULL)');
  const res = await conn.query('SELECT b, i, d, arr FROM node_decode_null');
  assert.deepStrictEqual(res.rows, [[null, null, null, null]]);
  await conn.close();
});

test('explicit transactions (autocommit: false)', async (server) => {
  const conn = await connect({ port: server.port, user: 'u', database: 'nusadb', autocommit: false });
  await conn.query('CREATE TABLE node_tx (id INT NOT NULL)');
  await conn.commit();

  // A rolled-back insert leaves no row.
  await conn.query('INSERT INTO node_tx VALUES (1)');
  await conn.rollback();
  let res = await conn.query('SELECT id FROM node_tx');
  assert.strictEqual(res.rows.length, 0, 'rolled-back insert discarded');

  // A committed insert persists, visible to a fresh autocommit connection.
  await conn.query('INSERT INTO node_tx VALUES (2)');
  await conn.commit();
  const other = await connect({ port: server.port, user: 'u', database: 'nusadb' });
  res = await other.query('SELECT id FROM node_tx');
  assert.deepStrictEqual(res.rows, [[2]], 'committed insert persists');
  await other.close();
  await conn.close();
});

test('savepoints (rollback to and release)', async (server) => {
  const conn = await connect({ port: server.port, user: 'u', database: 'nusadb', autocommit: false });
  await conn.query('CREATE TABLE node_sp (id INT NOT NULL)');
  await conn.commit();

  await conn.query('INSERT INTO node_sp VALUES (1)');
  await conn.savepoint('sp1');
  await conn.query('INSERT INTO node_sp VALUES (2)');
  await conn.rollbackToSavepoint('sp1'); // undoes (2), keeps (1), transaction continues
  await conn.query('INSERT INTO node_sp VALUES (3)');
  await conn.savepoint('sp2');
  await conn.query('INSERT INTO node_sp VALUES (4)');
  await conn.releaseSavepoint('sp2'); // keeps (4)
  await conn.commit();

  const res = await conn.query('SELECT id FROM node_sp ORDER BY id');
  assert.deepStrictEqual(res.rows, [[1], [3], [4]], 'savepoint kept 1,3,4 (2 rolled back)');

  // A savepoint is illegal without an open (non-autocommit) transaction.
  const auto = await connect({ port: server.port, user: 'u', database: 'nusadb' });
  await assert.rejects(() => auto.savepoint('nope'), /autocommit/);
  await auto.close();
  await conn.close();
});

test('LISTEN/NOTIFY self-delivery', async (server) => {
  const conn = await connect({ port: server.port, user: 'u', database: 'nusadb' });
  await conn.listen('node_chan');
  await conn.notify('node_chan', 'hello');
  const note = await conn.poll(5000);
  assert.ok(note, 'a notification was delivered');
  assert.strictEqual(note.channel, 'node_chan');
  assert.strictEqual(note.payload, 'hello');
  // NOTIFY without a payload delivers an empty string.
  await conn.notify('node_chan');
  const note2 = await conn.poll(5000);
  assert.strictEqual(note2.payload, '');
  // After UNLISTEN, a further NOTIFY is not delivered (poll times out -> null).
  await conn.unlisten('node_chan');
  await conn.notify('node_chan', 'ignored');
  assert.strictEqual(await conn.poll(300), null);
  await conn.close();
});

test('parameterised query with NULL', async (server) => {
  const conn = await connect({ port: server.port, user: 'u', database: 'nusadb' });
  await conn.query('CREATE TABLE node_params (id INT NOT NULL, name TEXT)');
  await conn.query('INSERT INTO node_params VALUES ($1, $2)', [1, 'alice']);
  await conn.query('INSERT INTO node_params VALUES ($1, $2)', [2, null]);
  const res = await conn.query('SELECT id, name FROM node_params WHERE id = $1', [2]);
  assert.deepStrictEqual(res.rows, [[2, null]]);
  await conn.close();
});

test('prepared statement reused', async (server) => {
  const conn = await connect({ port: server.port, user: 'u', database: 'nusadb' });
  await conn.query('CREATE TABLE node_prep (id INT NOT NULL)');
  const stmt = await conn.prepare('INSERT INTO node_prep VALUES ($1)');
  for (let i = 1; i <= 3; i += 1) await stmt.execute([i]);
  const res = await conn.query('SELECT id FROM node_prep');
  assert.strictEqual(res.rows.length, 3);
  await conn.close();
});

test('executeMany bulk insert', async (server) => {
  const conn = await connect({ port: server.port, user: 'u', database: 'nusadb' });
  await conn.query('CREATE TABLE node_batch (id INT NOT NULL, name TEXT)');
  const { rowCount, counts } = await conn.executeMany('INSERT INTO node_batch VALUES ($1, $2)', [
    [1, 'a'],
    [2, 'b'],
    [3, 'c'],
  ]);
  assert.strictEqual(rowCount, 3);
  assert.deepStrictEqual(counts, [1, 1, 1]);
  const res = await conn.query('SELECT count(*) FROM node_batch');
  assert.strictEqual(res.rows[0][0], 3);
  // An empty batch is a no-op.
  assert.deepStrictEqual(await conn.executeMany('INSERT INTO node_batch VALUES ($1, $2)', []), {
    rowCount: 0,
    counts: [],
  });
  await conn.close();
});

test('copy bulk load and export', async (server) => {
  const conn = await connect({ port: server.port, user: 'u', database: 'nusadb' });
  await conn.query('CREATE TABLE copy_t (id INT NOT NULL, name TEXT, PRIMARY KEY (id))');

  // COPY FROM STDIN: tab-delimited rows, \N for NULL.
  const loaded = await conn.copyIn('COPY copy_t FROM STDIN', '1\talice\n2\t\\N\n3\tcarol\n');
  assert.strictEqual(loaded, 3);

  const res = await conn.query('SELECT id, name FROM copy_t ORDER BY id');
  assert.deepStrictEqual(res.rows, [[1, 'alice'], [2, null], [3, 'carol']]);

  // COPY TO STDOUT: bytes come back in the same text format.
  const out = await conn.copyOut('COPY copy_t TO STDOUT');
  assert.strictEqual(out.rowCount, 3);
  assert.deepStrictEqual(out.data.toString('utf8').split('\n').filter(Boolean),
    ['1\talice', '2\t\\N', '3\tcarol']);

  // A refused COPY rejects, and the connection stays usable.
  await assert.rejects(() => conn.copyIn('COPY no_such_table FROM STDIN', ''));
  const again = await conn.query('SELECT count(*) FROM copy_t');
  assert.strictEqual(again.rows.length, 1);

  await conn.close();
});

test('bytea round trip', async (server) => {
  const conn = await connect({ port: server.port, user: 'u', database: 'nusadb' });
  await conn.query('CREATE TABLE bt (id INT NOT NULL, data BYTEA, PRIMARY KEY (id))');
  const payload = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x7f]);
  await conn.query('INSERT INTO bt VALUES ($1, $2)', [1, payload]);
  await conn.query('INSERT INTO bt VALUES ($1, $2)', [2, Buffer.alloc(0)]);
  await conn.query('INSERT INTO bt VALUES ($1, $2)', [3, null]);
  const res = await conn.query('SELECT id, data FROM bt ORDER BY id');
  assert.ok(Buffer.isBuffer(res.rows[0][1]), 'bytea decodes to a Buffer');
  assert.ok(res.rows[0][1].equals(payload), 'bytea round-trips losslessly');
  assert.strictEqual(res.rows[1][1].length, 0, 'empty bytea is an empty Buffer');
  assert.strictEqual(res.rows[2][1], null, 'null bytea');
  await conn.close();
});

test('query surface', async (server) => {
  const conn = await connect({ port: server.port, user: 'u', database: 'nusadb' });
  await conn.query('CREATE TABLE surf_a (id INT NOT NULL, grp TEXT, v INT)');
  await conn.query(
    "INSERT INTO surf_a VALUES (1, 'a', 10), (2, 'a', 30), (3, 'b', 20), (4, 'b', 20), (5, 'a', 10)"
  );
  await conn.query('CREATE TABLE surf_b (id INT NOT NULL, a_id INT, tag TEXT)');
  await conn.query("INSERT INTO surf_b VALUES (10, 1, 'p'), (11, 1, 'q'), (12, 2, 'r')");

  // Each entry: label, SQL, expected row count. The driver is a SQL-text
  // transport, so every query the server accepts round-trips unchanged.
  const cases = [
    ['ORDER BY', 'SELECT id FROM surf_a ORDER BY v DESC, id', 5],
    ['DISTINCT', 'SELECT DISTINCT v FROM surf_a ORDER BY v', 3],
    ['DISTINCT ON', 'SELECT DISTINCT ON (grp) grp, v FROM surf_a ORDER BY grp, v', 2],
    ['LIMIT', 'SELECT id FROM surf_a ORDER BY id LIMIT 2', 2],
    ['OFFSET', 'SELECT id FROM surf_a ORDER BY id LIMIT 2 OFFSET 3', 2],
    [
      'GROUP/HAVING',
      'SELECT grp, count(*) FROM surf_a GROUP BY grp HAVING count(*) > 1 ORDER BY grp',
      2,
    ],
    [
      'window',
      'SELECT id, row_number() OVER (PARTITION BY grp ORDER BY v) FROM surf_a ORDER BY id',
      5,
    ],
    ['CTE', 'WITH g AS (SELECT grp, count(*) c FROM surf_a GROUP BY grp) SELECT count(*) FROM g', 1],
    ['subquery IN', 'SELECT id FROM surf_a WHERE v IN (SELECT max(v) FROM surf_a) ORDER BY id', 1],
    ['UNION', 'SELECT id FROM surf_a WHERE id = 1 UNION SELECT id FROM surf_a WHERE id = 2', 2],
    [
      'INNER JOIN',
      'SELECT surf_a.grp, surf_b.tag FROM surf_a JOIN surf_b ON surf_a.id = surf_b.a_id ORDER BY surf_b.id',
      3,
    ],
    [
      'LEFT JOIN',
      'SELECT surf_a.grp, surf_b.tag FROM surf_a LEFT JOIN surf_b ON surf_a.id = surf_b.a_id ORDER BY surf_a.id, surf_b.id',
      6,
    ],
    [
      'RIGHT JOIN',
      'SELECT surf_a.grp, surf_b.tag FROM surf_a RIGHT JOIN surf_b ON surf_a.id = surf_b.a_id ORDER BY surf_b.id',
      3,
    ],
    [
      'FULL JOIN',
      'SELECT surf_a.grp, surf_b.tag FROM surf_a FULL JOIN surf_b ON surf_a.id = surf_b.a_id ORDER BY surf_a.id, surf_b.id',
      6,
    ],
    ['CROSS JOIN', 'SELECT surf_a.id, surf_b.id FROM surf_a CROSS JOIN surf_b', 15],
    [
      'LATERAL',
      'SELECT surf_a.id, l.tag FROM surf_a JOIN LATERAL (SELECT tag FROM surf_b WHERE surf_b.a_id = surf_a.id LIMIT 1) l ON true ORDER BY surf_a.id',
      2,
    ],
  ];

  for (const [label, sql, expected] of cases) {
    const res = await conn.query(sql);
    assert.strictEqual(
      res.rows.length,
      expected,
      `${label}: expected ${expected} rows, got ${res.rows.length}`
    );
  }
  await conn.close();
});

test('server error surfaces and connection survives', async (server) => {
  const conn = await connect({ port: server.port, user: 'u', database: 'nusadb' });
  await assert.rejects(() => conn.query('SELECT * FROM ghost'), (e) => {
    assert.ok(e instanceof NusaError);
    assert.strictEqual(e.code.length, 5);
    return true;
  });
  const ok = await conn.query('SELECT 1');
  assert.strictEqual(ok.rows.length, 1);
  await conn.close();
});

test('pool reuses connections', async (server) => {
  const pool = new Pool({ maxSize: 2, port: server.port, user: 'u', database: 'nusadb' });
  await pool.withConnection((c) => c.query('CREATE TABLE node_pool (id INT NOT NULL)'));
  assert.strictEqual(pool.idleCount, 1);
  await pool.withConnection(async (c) => {
    await c.query('INSERT INTO node_pool VALUES (7)');
    const res = await c.query('SELECT id FROM node_pool');
    assert.deepStrictEqual(res.rows, [[7]]);
  });
  assert.strictEqual(pool.idleCount, 1);
  await pool.close();
});

test('backend key captured', async (server) => {
  const conn = await connect({ port: server.port, user: 'u', database: 'nusadb' });
  assert.ok(conn.backendKey && conn.backendKey.pid > 0);
  await conn.close();
});

async function runTrust() {
  const server = await startServer();
  let failures = 0;
  for (const t of tests) {
    try {
      await t.fn(server);
      console.log(`ok   - ${t.name}`);
    } catch (err) {
      failures += 1;
      console.error(`FAIL - ${t.name}\n      ${err && err.stack ? err.stack : err}`);
    }
  }
  server.stop();
  return failures;
}

async function runScram() {
  const server = await startServer(['--auth-user', 'alice:secret']);
  let failures = 0;
  try {
    const conn = await connect({ port: server.port, user: 'alice', database: 'nusadb', password: 'secret' });
    const res = await conn.query('SELECT 1');
    assert.strictEqual(res.rows.length, 1);
    await conn.close();
    console.log('ok   - scram: correct password authenticates');
  } catch (err) {
    failures += 1;
    console.error(`FAIL - scram correct password\n      ${err}`);
  }
  try {
    await assert.rejects(() =>
      connect({ port: server.port, user: 'alice', database: 'nusadb', password: 'wrong' })
    );
    console.log('ok   - scram: wrong password rejected');
  } catch (err) {
    failures += 1;
    console.error(`FAIL - scram wrong password\n      ${err}`);
  }
  server.stop();
  return failures;
}

(async () => {
  const failures = (await runTrust()) + (await runScram());
  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log('\nall tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
