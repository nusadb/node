'use strict';

// Client-side SCRAM-SHA-256 (RFC 5802 / RFC 7677), docs/wire-protocol.md §7.2.
// Uses Node's built-in `crypto` (no dependencies).

const crypto = require('crypto');

const GS2_HEADER = 'n,,';
const CHANNEL_BINDING = Buffer.from(GS2_HEADER, 'ascii').toString('base64'); // "biws"

function hmac(key, msg) {
  return crypto.createHmac('sha256', key).update(msg).digest();
}

function clientFirst(user) {
  const nonce = crypto.randomBytes(18).toString('base64');
  const bare = `n=${user},r=${nonce}`;
  return { bare, full: GS2_HEADER + bare };
}

function parseServerFirst(message) {
  const parts = {};
  for (const field of message.split(',')) {
    const i = field.indexOf('=');
    if (i > 0) parts[field.slice(0, i)] = field.slice(i + 1);
  }
  const combinedNonce = parts.r;
  const salt = Buffer.from(parts.s, 'base64');
  const iterations = parseInt(parts.i, 10);
  if (!combinedNonce || salt.length === 0 || !(iterations > 0)) {
    throw new Error('nusadb: malformed server-first message');
  }
  return { combinedNonce, salt, iterations };
}

function clientFinal(password, clientFirstBare, serverFirst) {
  const { combinedNonce, salt, iterations } = parseServerFirst(serverFirst);

  const salted = crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, 32, 'sha256');
  const clientKey = hmac(salted, 'Client Key');
  const storedKey = crypto.createHash('sha256').update(clientKey).digest();

  const withoutProof = `c=${CHANNEL_BINDING},r=${combinedNonce}`;
  const authMessage = `${clientFirstBare},${serverFirst},${withoutProof}`;
  const clientSig = hmac(storedKey, authMessage);

  const proof = Buffer.alloc(clientKey.length);
  for (let i = 0; i < proof.length; i += 1) proof[i] = clientKey[i] ^ clientSig[i];
  const final = `${withoutProof},p=${proof.toString('base64')}`;

  const serverKey = hmac(salted, 'Server Key');
  const serverSig = hmac(serverKey, authMessage);
  return { final: Buffer.from(final, 'utf8'), expected: serverSig.toString('base64') };
}

function verifyServerFinal(serverFinal, expectedB64) {
  let got = '';
  for (const field of serverFinal.split(',')) {
    if (field.startsWith('v=')) got = field.slice(2);
  }
  const a = Buffer.from(got, 'utf8');
  const b = Buffer.from(expectedB64, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { clientFirst, clientFinal, verifyServerFinal };
