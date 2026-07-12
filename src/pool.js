'use strict';

const { Connection } = require('./connection');

/** A bounded async connection pool. */
class Pool {
  constructor(options = {}) {
    const { maxSize = 10, ...connOptions } = options;
    this._max = Math.max(1, maxSize);
    this._options = connOptions;
    this._idle = [];
    this._live = 0;
    this._waiters = [];
    this._closed = false;
  }

  get idleCount() {
    return this._idle.length;
  }

  async acquire() {
    if (this._closed) throw new Error('nusadb: pool is closed');
    if (this._idle.length) return this._idle.pop();
    if (this._live < this._max) {
      this._live += 1;
      try {
        return await Connection.connect(this._options);
      } catch (err) {
        this._live -= 1;
        throw err;
      }
    }
    return new Promise((resolve, reject) => this._waiters.push({ resolve, reject }));
  }

  release(conn) {
    const waiter = this._waiters.shift();
    if (waiter) {
      waiter.resolve(conn);
    } else {
      this._idle.push(conn);
    }
  }

  /** Acquire a connection, run `fn`, and always release it. */
  async withConnection(fn) {
    const conn = await this.acquire();
    try {
      return await fn(conn);
    } finally {
      this.release(conn);
    }
  }

  async close() {
    this._closed = true;
    const idle = this._idle;
    this._idle = [];
    await Promise.all(idle.map((c) => c.close()));
  }
}

module.exports = { Pool };
