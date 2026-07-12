'use strict';

// Low-level Nusa Wire Protocol codec (docs/wire-protocol.md, PROTOCOL_VERSION 1.1).
// A frame is [type:u8][len:u32][payload]; len is the total including the 5-byte
// header. Big-endian throughout; strings are [len:u32][utf8 bytes], not null-terminated.

const PROTOCOL_MAGIC = 0x4e555341; // "NUSA"
const PROTOCOL_MAJOR = 1;
// Protocol 1.1 (R42-B.02): request minor 1 to receive the typed RowDescription (per-column type
// tags). A 1.0 server ignores the minor and answers with the classic untyped RowDescription, which
// the driver still handles — so requesting 1 is safe against any server.
const PROTOCOL_MINOR = 1;

// Column type tags carried by RowDescriptionTyped (protocol 1.1, wire-protocol.md §9.2). Maps the
// 1-byte tag to a canonical type name; an unrecognised tag (or 0x00) is treated as UNKNOWN/TEXT.
const TYPE_TAGS = {
  0x00: 'UNKNOWN',
  0x01: 'BOOL',
  0x02: 'INT',
  0x03: 'FLOAT',
  0x04: 'NUMERIC',
  0x05: 'TEXT',
  0x06: 'BYTES',
  0x07: 'DATE',
  0x08: 'TIME',
  0x09: 'TIMETZ',
  0x0a: 'TIMESTAMP',
  0x0b: 'TIMESTAMPTZ',
  0x0c: 'INTERVAL',
  0x0d: 'UUID',
  0x0e: 'JSON',
  0x0f: 'ARRAY',
  0x10: 'VECTOR',
};

function typeName(tag) {
  return TYPE_TAGS[tag] || 'UNKNOWN';
}
const HEADER_LEN = 5;
const MAX_FRAME_LEN = 256 * 1024 * 1024;
const SCRAM_MECHANISM = 'SCRAM-SHA-256';

// Backend message type bytes.
const B = {
  AUTH: 0x52, // R
  BACKEND_KEY: 0x4b, // K
  READY: 0x5a, // Z
  COMMAND_COMPLETE: 0x43, // C
  ERROR: 0x45, // E
  ROW_DESCRIPTION: 0x54, // T
  ROW_DESCRIPTION_TYPED: 0x79, // y (protocol 1.1)
  DATA_ROW: 0x44, // D
  PARSE_COMPLETE: 0x31, // 1
  BIND_COMPLETE: 0x32, // 2
  NO_DATA: 0x6e, // n
  PARAMETER_DESCRIPTION: 0x74, // t
  COPY_IN: 0x47, // G (CopyInResponse, §12.1)
  COPY_OUT: 0x48, // H (CopyOutResponse, §12.2)
  COPY_DATA: 0x64, // d (a COPY data chunk)
  COPY_DONE: 0x63, // c (end of the COPY data stream)
  NOTIFICATION: 0x41, // A (async LISTEN/NOTIFY: [pid:u32][channel:str][payload:str])
};

// Frontend message type bytes.
const F = {
  STARTUP: 0x53, // S
  QUERY: 0x51, // Q
  PARSE: 0x50, // P
  BIND: 0x42, // B
  DESCRIBE: 0x44, // D
  EXECUTE: 0x45, // E
  SYNC: 0x59, // Y
  SASL_INITIAL: 0x70, // p
  SASL_RESPONSE: 0x72, // r
  CANCEL: 0x4b, // K
  TERMINATE: 0x58, // X
  COPY_DATA: 0x64, // d
  COPY_DONE: 0x63, // c
  COPY_FAIL: 0x66, // f
};

const AUTH = { OK: 0, SASL: 10, SASL_CONTINUE: 11, SASL_FINAL: 12 };

function u32(value) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(value >>> 0, 0);
  return b;
}

function u16(value) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(value & 0xffff, 0);
  return b;
}

function str(s) {
  const body = Buffer.from(s, 'utf8');
  return Buffer.concat([u32(body.length), body]);
}

function frame(type, payload) {
  const total = payload.length + HEADER_LEN;
  const head = Buffer.alloc(HEADER_LEN);
  head[0] = type;
  head.writeUInt32BE(total, 1);
  return Buffer.concat([head, payload]);
}

// Encode a Fields list: [count:u16] then per field a present byte (0 = NULL,
// 1 = [len:u32][bytes]). `values` is an array of Buffer|null.
function fields(values) {
  const parts = [u16(values.length)];
  for (const v of values) {
    if (v === null || v === undefined) {
      parts.push(Buffer.from([0]));
    } else {
      parts.push(Buffer.from([1]), u32(v.length), v);
    }
  }
  return Buffer.concat(parts);
}

// --- frontend message builders ---

const encode = {
  startup(user, database) {
    return frame(
      F.STARTUP,
      Buffer.concat([u32(PROTOCOL_MAGIC), u16(PROTOCOL_MAJOR), u16(PROTOCOL_MINOR), str(user), str(database)])
    );
  },
  query(sql) {
    return frame(F.QUERY, str(sql));
  },
  parse(name, sql) {
    return frame(F.PARSE, Buffer.concat([str(name), str(sql), u16(0)]));
  },
  bind(portal, statement, values) {
    return frame(F.BIND, Buffer.concat([str(portal), str(statement), fields(values), u16(0)]));
  },
  describePortal(name) {
    return frame(F.DESCRIBE, Buffer.concat([Buffer.from([0x50]), str(name)]));
  },
  execute(portal, maxRows) {
    return frame(F.EXECUTE, Buffer.concat([str(portal), u32(maxRows || 0)]));
  },
  sync() {
    return frame(F.SYNC, Buffer.alloc(0));
  },
  terminate() {
    return frame(F.TERMINATE, Buffer.alloc(0));
  },
  saslInitial(mechanism, data) {
    return frame(F.SASL_INITIAL, Buffer.concat([str(mechanism), u32(data.length), data]));
  },
  saslResponse(data) {
    return frame(F.SASL_RESPONSE, data);
  },
  cancel(pid, secret) {
    return frame(F.CANCEL, Buffer.concat([u32(pid), u32(secret)]));
  },
  copyData(data) {
    return frame(F.COPY_DATA, data);
  },
  copyDone() {
    return frame(F.COPY_DONE, Buffer.alloc(0));
  },
  copyFail(message) {
    return frame(F.COPY_FAIL, str(message));
  },
};

// Reader over a payload Buffer.
class Reader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }
  u8() {
    const v = this.buf.readUInt8(this.pos);
    this.pos += 1;
    return v;
  }
  u16() {
    const v = this.buf.readUInt16BE(this.pos);
    this.pos += 2;
    return v;
  }
  u32() {
    const v = this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return v;
  }
  str() {
    const n = this.u32();
    const s = this.buf.toString('utf8', this.pos, this.pos + n);
    this.pos += n;
    return s;
  }
  rest() {
    const b = this.buf.subarray(this.pos);
    this.pos = this.buf.length;
    return b;
  }
  fields() {
    const n = this.u16();
    const out = [];
    for (let i = 0; i < n; i += 1) {
      if (this.u8() === 0) {
        out.push(null);
      } else {
        const len = this.u32();
        out.push(Buffer.from(this.buf.subarray(this.pos, this.pos + len)));
        this.pos += len;
      }
    }
    return out;
  }
}

module.exports = {
  PROTOCOL_MAGIC,
  HEADER_LEN,
  MAX_FRAME_LEN,
  SCRAM_MECHANISM,
  B,
  F,
  AUTH,
  TYPE_TAGS,
  typeName,
  encode,
  Reader,
};
