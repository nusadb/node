'use strict';

const { Connection, NusaError } = require('./connection');
const { Pool } = require('./pool');

/**
 * Open a connection to a NusaDB server.
 * @param {object} options host, port, user, database, password, tls
 * @returns {Promise<Connection>}
 */
function connect(options) {
  return Connection.connect(options);
}

module.exports = { connect, Connection, Pool, NusaError };
