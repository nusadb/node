'use strict';

const net = require('net');
const tls = require('tls');
const { encode, Reader, B, AUTH, HEADER_LEN, MAX_FRAME_LEN, SCRAM_MECHANISM, typeName } = require('./protocol');
const scram = require('./scram');

/** A server error carrying a 5-character SQLSTATE (docs/wire-protocol.md §14). */
class NusaError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'NusaError';
    this.code = code;
    this.sqlMessage = message;
  }
}

/** Reads length-delimited frames off a socket and hands them out one at a time. */
class FrameReader {
  constructor(socket) {
    this._buf = Buffer.alloc(0);
    this._queue = [];
    this._waiters = [];
    this._error = null;
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (e) => this._fail(e));
    socket.on('close', () => this._fail(new Error('nusadb: connection closed')));
  }

  _onData(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    while (this._buf.length >= HEADER_LEN) {
      const total = this._buf.readUInt32BE(1);
      if (total < HEADER_LEN || total > MAX_FRAME_LEN) {
        this._fail(new Error(`nusadb: invalid frame length ${total}`));
        return;
      }
      if (this._buf.length < total) break;
      const msg = { type: this._buf[0], payload: Buffer.from(this._buf.subarray(HEADER_LEN, total)) };
      this._buf = this._buf.subarray(total);
      const waiter = this._waiters.shift();
      if (waiter) waiter.resolve(msg);
      else this._queue.push(msg);
    }
  }

  _fail(err) {
    if (this._error) return;
    this._error = err;
    for (const w of this._waiters) w.reject(err);
    this._waiters = [];
  }

  read() {
    if (this._queue.length) return Promise.resolve(this._queue.shift());
    if (this._error) return Promise.reject(this._error);
    return new Promise((resolve, reject) => this._waiters.push({ resolve, reject }));
  }

  /** Read the next frame, or resolve to `null` after `ms` if none arrives. `ms === null` blocks.
   * On timeout the pending waiter is removed so it never swallows a later frame. */
  readWithTimeout(ms) {
    if (this._queue.length) return Promise.resolve(this._queue.shift());
    if (this._error) return Promise.reject(this._error);
    return new Promise((resolve, reject) => {
      let timer = null;
      const waiter = {
        resolve: (msg) => {
          if (timer) clearTimeout(timer);
          resolve(msg);
        },
        reject: (err) => {
          if (timer) clearTimeout(timer);
          reject(err);
        },
      };
      this._waiters.push(waiter);
      if (ms !== null && ms !== undefined) {
        timer = setTimeout(() => {
          const idx = this._waiters.indexOf(waiter);
          if (idx >= 0) this._waiters.splice(idx, 1);
          resolve(null);
        }, ms);
      }
    });
  }
}

/** Quotes a savepoint identifier so an arbitrary name is emitted safely; the server folds a quoted
 * identifier to its literal value, so the same quoting matches across SAVEPOINT/ROLLBACK/RELEASE. */
function quoteIdentifier(name) {
  if (typeof name !== 'string') {
    throw new TypeError('nusadb: savepoint name must be a string');
  }
  return `"${name.replace(/"/g, '""')}"`;
}

/** Quotes a string as a SQL literal (`'…'`, doubling `'`) — used for a NOTIFY payload. */
function quoteLiteral(text) {
  return `'${String(text).replace(/'/g, "''")}'`;
}

/** Decode a NotificationResponse body: `[pid:u32][channel:str][payload:str]`. */
function decodeNotification(r) {
  return { pid: r.u32(), channel: r.str(), payload: r.str() };
}

function encodeParam(value) {
  if (value === null || value === undefined) return null;
  // A Buffer binds as the BYTEA text form `\x<hex>`, which the server coerces into a BYTEA column.
  if (Buffer.isBuffer(value)) return Buffer.from(`\\x${value.toString('hex')}`, 'utf8');
  if (typeof value === 'boolean') return Buffer.from(value ? 'true' : 'false');
  return Buffer.from(String(value), 'utf8');
}

/** Decode the BYTEA text form `\x<hex>` to a Buffer. */
function decodeBytea(text) {
  return Buffer.from(text.startsWith('\\x') ? text.slice(2) : text, 'hex');
}

function decodeBool(text) {
  if (text === 'true' || text === 't' || text === '1') return true;
  if (text === 'false' || text === 'f' || text === '0') return false;
  throw new Error('not a bool');
}

function decodeInt(text) {
  const n = Number(text);
  // A 64-bit value beyond JS's safe-integer range becomes a BigInt to avoid silent precision loss;
  // BigInt() throws on a non-integer, so the caller falls back to the raw text.
  return Number.isSafeInteger(n) ? n : BigInt(text);
}

function decodeFloat(text) {
  const n = Number(text);
  if (Number.isNaN(n) && text !== 'NaN') throw new Error('not a float');
  return n;
}

function decodeTimestamp(text) {
  // Make the wire text ISO-parseable: space -> 'T', and pad a bare +HH offset to +HH:00.
  const iso = text.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error('not a date');
  return d;
}

function decodeDate(text) {
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) throw new Error('not a date');
  return d;
}

/** Parse a SQL array literal (`{a,b,c}`, possibly nested, quoted, or with `NULL`) to a JS
 * array. Elements stay strings (the wire array tag carries no per-element type); a quoted element is
 * unescaped and an unquoted `NULL` becomes `null`. */
function parseArray(text) {
  let pos = 0;
  function parseList() {
    if (text[pos] !== '{') throw new Error('not an array');
    pos += 1;
    const items = [];
    if (text[pos] === '}') {
      pos += 1;
      return items;
    }
    for (;;) {
      const ch = text[pos];
      if (ch === '{') items.push(parseList());
      else if (ch === '"') items.push(parseQuoted());
      else items.push(parseUnquoted());
      const sep = text[pos];
      if (sep === ',') {
        pos += 1;
        continue;
      }
      if (sep === '}') {
        pos += 1;
        break;
      }
      throw new Error('malformed array');
    }
    return items;
  }
  function parseQuoted() {
    pos += 1; // opening quote
    let out = '';
    while (text[pos] !== '"') {
      if (pos >= text.length) throw new Error('unterminated array element');
      if (text[pos] === '\\') pos += 1;
      out += text[pos];
      pos += 1;
    }
    pos += 1; // closing quote
    return out;
  }
  function parseUnquoted() {
    const start = pos;
    while (pos < text.length && text[pos] !== ',' && text[pos] !== '}') pos += 1;
    const token = text.slice(start, pos);
    return token === 'NULL' ? null : token;
  }
  const result = parseList();
  if (pos !== text.length) throw new Error('trailing array data');
  return result;
}

// Maps a RowDescriptionTyped type name (protocol 1.1) to the function that turns wire text into a
// typed JS value, following mainstream Node SQL driver conventions. NUMERIC, UUID, TIME/TIMETZ, INTERVAL, and
// TEXT stay strings (no lossless native JS type); BYTES is handled separately in `decodeCell`.
const TYPED_DECODERS = {
  BOOL: decodeBool,
  INT: decodeInt,
  FLOAT: decodeFloat,
  JSON: JSON.parse,
  ARRAY: parseArray,
  DATE: decodeDate,
  TIMESTAMP: decodeTimestamp,
  TIMESTAMPTZ: decodeTimestamp,
};

/** Decode one text-format field into a typed JS value by its wire type tag (`null` for SQL NULL). A
 * value that does not parse as its tag falls back to the raw text, so an unexpected form never throws
 * mid-decode. */
function decodeCell(cell, type) {
  if (cell === null) return null;
  if (type === 'BYTES') return decodeBytea(cell.toString('utf8'));
  const text = cell.toString('utf8');
  const decoder = TYPED_DECODERS[type];
  if (!decoder) return text;
  try {
    return decoder(text);
  } catch {
    return text;
  }
}

/** One authenticated connection to a NusaDB server. */
class Connection {
  constructor(socket, options) {
    this._socket = socket;
    this._reader = new FrameReader(socket);
    this._options = options;
    this._counter = 0;
    this.backendKey = null;
    // When `autocommit` is false, a transaction is opened lazily (BEGIN) before the first statement
    // and ended by commit()/rollback(). In autocommit mode the server runs each statement on its own.
    this._inTxn = false;
    // Async LISTEN/NOTIFY messages received while reading other responses; drained by notifications().
    this._notifications = [];
  }

  /** Open, handshake, and authenticate. Returns a ready Connection. */
  static connect(options = {}) {
    const opts = {
      host: '127.0.0.1',
      port: 5678,
      user: 'nusa-root',
      database: 'nusadb',
      password: 'nusa-root',
      tls: null,
      autocommit: true,
      ...options,
    };
    return new Promise((resolve, reject) => {
      const onError = (e) => reject(e);
      const socket = opts.tls
        ? tls.connect({ host: opts.host, port: opts.port, ...opts.tls }, onConnect)
        : net.connect({ host: opts.host, port: opts.port }, onConnect);
      // Disable Nagle's algorithm: this is a request/response protocol, so
      // coalescing small frames only adds delayed-ACK latency per round-trip.
      socket.setNoDelay(true);
      socket.once('error', onError);
      function onConnect() {
        socket.removeListener('error', onError);
        const conn = new Connection(socket, opts);
        conn._handshake().then(() => resolve(conn)).catch((err) => {
          socket.destroy();
          reject(err);
        });
      }
    });
  }

  _send(frame) {
    this._socket.write(frame);
  }

  /** Send a transaction-control statement (BEGIN/COMMIT/ROLLBACK) and drain to ReadyForQuery. */
  async _runControl(sql) {
    this._send(encode.query(sql));
    await this._collect();
  }

  /** Open a transaction before the first statement when not in autocommit mode. */
  async _beginIfNeeded() {
    if (!this._options.autocommit && !this._inTxn) {
      await this._runControl('BEGIN');
      this._inTxn = true;
    }
  }

  /** Commit the current transaction. A no-op in autocommit mode or with no open transaction. */
  async commit() {
    if (!this._options.autocommit && this._inTxn) {
      await this._runControl('COMMIT');
      this._inTxn = false;
    }
  }

  /** Roll back the current transaction, discarding its uncommitted changes. A no-op in autocommit
   * mode or with no open transaction. */
  async rollback() {
    if (!this._options.autocommit && this._inTxn) {
      await this._runControl('ROLLBACK');
      this._inTxn = false;
    }
  }

  /** Establish a savepoint inside the open transaction (SAVEPOINT name) — a named marker you can
   * later roll back to without ending the transaction. Requires autocommit off; a BEGIN is opened
   * lazily if none is active yet. */
  async savepoint(name) {
    if (this._options.autocommit) {
      throw new Error('nusadb: cannot set a savepoint in autocommit mode');
    }
    await this._beginIfNeeded();
    await this._runControl(`SAVEPOINT ${quoteIdentifier(name)}`);
  }

  /** Roll back to a savepoint (ROLLBACK TO SAVEPOINT name); the transaction stays open. */
  async rollbackToSavepoint(name) {
    if (this._options.autocommit || !this._inTxn) {
      throw new Error('nusadb: no active transaction to roll back to a savepoint');
    }
    await this._runControl(`ROLLBACK TO SAVEPOINT ${quoteIdentifier(name)}`);
  }

  /** Release (forget) a savepoint (RELEASE SAVEPOINT name), keeping its work. */
  async releaseSavepoint(name) {
    if (this._options.autocommit || !this._inTxn) {
      throw new Error('nusadb: no active transaction to release a savepoint');
    }
    await this._runControl(`RELEASE SAVEPOINT ${quoteIdentifier(name)}`);
  }

  /** Subscribe to asynchronous notifications on `channel` (LISTEN channel). Collect them with
   * notifications() or poll(). */
  async listen(channel) {
    await this._runControl(`LISTEN ${quoteIdentifier(channel)}`);
  }

  /** Stop listening on `channel` (UNLISTEN channel), or on every channel when `channel` is omitted
   * (UNLISTEN *). */
  async unlisten(channel) {
    const target = channel === undefined || channel === null ? '*' : quoteIdentifier(channel);
    await this._runControl(`UNLISTEN ${target}`);
  }

  /** Send a notification on `channel` with an optional `payload` (NOTIFY channel[, 'payload']). */
  async notify(channel, payload) {
    let sql = `NOTIFY ${quoteIdentifier(channel)}`;
    if (payload !== undefined && payload !== null) sql += `, ${quoteLiteral(payload)}`;
    await this._runControl(sql);
  }

  /** Return and clear the notifications already received (buffered while reading other responses).
   * Does not touch the socket — use poll() to wait for new ones. */
  notifications() {
    const pending = this._notifications;
    this._notifications = [];
    return pending;
  }

  /** Wait up to `timeoutMs` for the next notification (a buffered one is returned immediately; `null`
   * on timeout). `timeoutMs` of `null` blocks until one arrives; `0` polls without blocking. Only
   * meaningful after listen(). */
  async poll(timeoutMs = 0) {
    if (this._notifications.length) return this._notifications.shift();
    const msg = await this._reader.readWithTimeout(timeoutMs);
    if (msg === null) return null;
    if (msg.type === B.NOTIFICATION) return decodeNotification(new Reader(msg.payload));
    if (msg.type === B.ERROR) {
      const r = new Reader(msg.payload);
      throw new NusaError(r.str(), r.str());
    }
    throw new Error(`nusadb: unexpected message ${msg.type} while polling for notifications`);
  }

  async _read() {
    return this._reader.read();
  }

  async _handshake() {
    this._send(encode.startup(this._options.user, this._options.database));
    for (;;) {
      const msg = await this._read();
      if (msg.type === B.READY) return;
      if (msg.type === B.ERROR) {
        const r = new Reader(msg.payload);
        throw new NusaError(r.str(), r.str());
      }
      if (msg.type === B.AUTH) {
        const r = new Reader(msg.payload);
        const sub = r.u32();
        if (sub === AUTH.SASL) {
          const count = r.u16();
          const mechs = [];
          for (let i = 0; i < count; i += 1) mechs.push(r.str());
          await this._scram(mechs);
        }
      } else if (msg.type === B.BACKEND_KEY) {
        const r = new Reader(msg.payload);
        this.backendKey = { pid: r.u32(), secret: r.u32() };
      }
    }
  }

  async _scram(mechs) {
    if (!mechs.includes(SCRAM_MECHANISM)) {
      throw new Error('nusadb: server offered no supported SASL mechanism');
    }
    if (this._options.password === null || this._options.password === undefined) {
      throw new Error('nusadb: server requires a password but none was given');
    }
    const { bare, full } = scram.clientFirst(this._options.user);
    this._send(encode.saslInitial(SCRAM_MECHANISM, Buffer.from(full, 'utf8')));

    let msg = await this._read();
    if (msg.type === B.ERROR) {
      const r = new Reader(msg.payload);
      throw new NusaError(r.str(), r.str());
    }
    let r = new Reader(msg.payload);
    if (msg.type !== B.AUTH || r.u32() !== AUTH.SASL_CONTINUE) {
      throw new Error('nusadb: expected a SASL continue message');
    }
    const serverFirst = r.rest().toString('utf8');

    const { final, expected } = scram.clientFinal(this._options.password, bare, serverFirst);
    this._send(encode.saslResponse(final));

    msg = await this._read();
    if (msg.type === B.ERROR) {
      const er = new Reader(msg.payload);
      throw new NusaError(er.str(), er.str());
    }
    r = new Reader(msg.payload);
    if (msg.type !== B.AUTH || r.u32() !== AUTH.SASL_FINAL) {
      throw new Error('nusadb: expected a SASL final message');
    }
    if (!scram.verifyServerFinal(r.rest().toString('utf8'), expected)) {
      throw new Error('nusadb: server signature did not verify');
    }
  }

  async _collect() {
    let columns = [];
    // Per-column type name, parallel to `columns`. `null` for an untyped (protocol 1.0)
    // RowDescription; a canonical type name (e.g. 'INT') for the 1.1 typed form.
    let columnTypes = [];
    const rows = [];
    let tag = null;
    let error = null;
    for (;;) {
      const msg = await this._read();
      const r = new Reader(msg.payload);
      switch (msg.type) {
        case B.ROW_DESCRIPTION: {
          const n = r.u16();
          columns = [];
          columnTypes = [];
          for (let i = 0; i < n; i += 1) {
            columns.push(r.str());
            columnTypes.push(null);
          }
          break;
        }
        case B.ROW_DESCRIPTION_TYPED: {
          const n = r.u16();
          columns = [];
          columnTypes = [];
          for (let i = 0; i < n; i += 1) {
            columns.push(r.str());
            columnTypes.push(typeName(r.u8()));
          }
          break;
        }
        case B.DATA_ROW:
          rows.push(r.fields());
          break;
        case B.COMMAND_COMPLETE:
          tag = r.str();
          break;
        case B.NOTIFICATION:
          // A pending LISTEN/NOTIFY message can lead the next query's response; buffer it.
          this._notifications.push(decodeNotification(r));
          break;
        case B.ERROR:
          error = new NusaError(r.str(), r.str());
          break;
        case B.READY:
          if (error) throw error;
          return { columns, columnTypes, rows, tag };
        default:
          break;
      }
    }
  }

  _freshName(prefix) {
    this._counter += 1;
    return `nusa_${prefix}_${this._counter}`;
  }

  /** Run one SQL string (simple query). Returns { columns, rows, rowCount, command }. */
  async query(sql, params) {
    await this._beginIfNeeded();
    let raw;
    if (params && params.length) {
      const encoded = params.map(encodeParam);
      this._send(encode.parse('', sql));
      this._send(encode.bind('', '', encoded));
      this._send(encode.describePortal(''));
      this._send(encode.execute('', 0));
      this._send(encode.sync());
      raw = await this._collect();
    } else {
      this._send(encode.query(sql));
      raw = await this._collect();
    }
    return shape(raw);
  }

  /** Prepare a named statement; returns a handle with .execute(params). */
  async prepare(sql) {
    const name = this._freshName('stmt');
    this._send(encode.parse(name, sql));
    this._send(encode.sync());
    await this._collect(); // surfaces a parse error
    const self = this;
    return {
      name,
      async execute(params) {
        await self._beginIfNeeded();
        const encoded = (params || []).map(encodeParam);
        const portal = self._freshName('portal');
        self._send(encode.bind(portal, name, encoded));
        self._send(encode.describePortal(portal));
        self._send(encode.execute(portal, 0));
        self._send(encode.sync());
        return shape(await self._collect());
      },
    };
  }

  /**
   * Run one statement once per parameter set, reusing a single prepared statement — the bulk
   * insert/update path. Returns `{ rowCount, counts }`: `counts[i]` is the affected-row count of the
   * i-th set, `rowCount` their sum. One parse, then one execute per set (the wire protocol has no
   * batch pipeline, so this is N round-trips, not one). The first failing set rejects.
   */
  async executeMany(sql, paramSets) {
    const stmt = await this.prepare(sql);
    const counts = [];
    let rowCount = 0;
    for (const params of paramSets || []) {
      const res = await stmt.execute(params);
      const n = res.rowCount == null ? 0 : res.rowCount;
      counts.push(n);
      rowCount += n;
    }
    return { rowCount, counts };
  }

  /**
   * Bulk-load via `COPY ... FROM STDIN` (§12.1). `data` is a Buffer or string already in the
   * server's text format (tab-delimited fields, `\N` for SQL NULL, one row per line); it is sent in
   * 64 KiB `CopyData` chunks. Resolves to the number of rows loaded. A refused COPY (bad SQL, an
   * RLS-protected table) rejects; the connection stays usable.
   */
  async copyIn(sql, data) {
    await this._beginIfNeeded();
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    this._send(encode.query(sql));
    await this._awaitCopyStart(B.COPY_IN);
    for (let off = 0; off < buf.length; off += 65536) {
      this._send(encode.copyData(buf.subarray(off, Math.min(off + 65536, buf.length))));
    }
    this._send(encode.copyDone());
    return this._finishCopy();
  }

  /**
   * Bulk-export via `COPY ... TO STDOUT` (§12.2). Resolves to `{ rowCount, data }`, where `data` is a
   * Buffer of the server's text-format rows (tab-delimited, `\N` for NULL).
   */
  async copyOut(sql) {
    await this._beginIfNeeded();
    this._send(encode.query(sql));
    await this._awaitCopyStart(B.COPY_OUT);
    const chunks = [];
    for (;;) {
      const msg = await this._read();
      if (msg.type === B.COPY_DATA) {
        chunks.push(msg.payload);
      } else if (msg.type === B.COPY_DONE) {
        break;
      } else if (msg.type === B.ERROR) {
        const r = new Reader(msg.payload);
        const err = new NusaError(r.str(), r.str());
        await this._drainToReady();
        throw err;
      }
    }
    const rowCount = await this._finishCopy();
    return { rowCount, data: Buffer.concat(chunks) };
  }

  /** Read until the expected CopyInResponse/CopyOutResponse; a refused COPY arrives as Error then
   * ReadyForQuery and is thrown, the connection left ready. */
  async _awaitCopyStart(expected) {
    let error = null;
    for (;;) {
      const msg = await this._read();
      if (msg.type === expected) return;
      if (msg.type === B.ERROR) {
        const r = new Reader(msg.payload);
        error = new NusaError(r.str(), r.str());
      } else if (msg.type === B.READY) {
        throw error || new Error('nusadb: COPY did not start');
      }
    }
  }

  /** Drain to ReadyForQuery, returning the row count from the `COPY <n>` command tag. */
  async _finishCopy() {
    let tag = null;
    let error = null;
    for (;;) {
      const msg = await this._read();
      if (msg.type === B.COMMAND_COMPLETE) {
        tag = new Reader(msg.payload).str();
      } else if (msg.type === B.ERROR) {
        const r = new Reader(msg.payload);
        error = new NusaError(r.str(), r.str());
      } else if (msg.type === B.READY) {
        if (error) throw error;
        return affected(tag) || 0;
      }
    }
  }

  /** Best-effort resync: read and discard frames until ReadyForQuery. */
  async _drainToReady() {
    for (;;) {
      const msg = await this._read();
      if (msg.type === B.READY) return;
    }
  }

  /** Close the connection (Terminate). */
  async close() {
    try {
      this._send(encode.terminate());
    } catch (_e) {
      // ignore
    }
    this._socket.destroy();
  }
}

function affected(tag) {
  if (!tag) return null;
  const last = tag.split(' ').pop();
  const n = Number.parseInt(last, 10);
  return Number.isNaN(n) ? null : n;
}

function shape(raw) {
  const types = raw.columnTypes || [];
  // Each cell decodes to its natural JS type by the column's protocol 1.1 type tag (see decodeCell).
  const rows = raw.rows.map((fieldList) => fieldList.map((cell, i) => decodeCell(cell, types[i])));
  return {
    columns: raw.columns,
    // Per-column type names (protocol 1.1, R42-B.03); each entry is a canonical type name or `null`
    // when the server answered with the untyped (1.0) RowDescription.
    columnTypes: raw.columnTypes || raw.columns.map(() => null),
    rows,
    rowCount: raw.columns.length ? rows.length : affected(raw.tag),
    command: raw.tag,
  };
}

module.exports = { Connection, NusaError };
