const mongoose = require('mongoose');

// The live database. Only a human may point the gateway at it, by setting ALLOW_LIVE_DB=1.
const LIVE_DB_NAME = 'intellisched_db';

class DatabaseRefusedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DatabaseRefusedError';
  }
}

// Database name from a connection string: the path after the host list, before any query.
// Returns null when the URI names none (the driver then falls back to "test").
const databaseNameFromUri = (uri) => {
  const match = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]*)/.exec(String(uri || '').trim());
  return match && match[1] ? decodeURIComponent(match[1]) : null;
};

// E2E mode (E2E_MODE=1: Playwright and the UI audit drive this gateway) allows only databases whose
// name ends in "_test", whatever else is set.
const isE2EMode = (env = process.env) => env.E2E_MODE === '1';
const isTestDatabaseName = (dbName) => typeof dbName === 'string' && dbName.endsWith('_test');

// Throws DatabaseRefusedError when the target database may not be used from this process.
const assertDatabaseAllowed = (dbName, env = process.env) => {
  if (isE2EMode(env) && !isTestDatabaseName(dbName)) {
    throw new DatabaseRefusedError(
      `E2E mode refuses the database "${dbName || '(none named)'}": end-to-end tests run only against a database whose name ends in "_test".`
    );
  }
  if (dbName === LIVE_DB_NAME && env.ALLOW_LIVE_DB !== '1') {
    throw new DatabaseRefusedError(
      `Refusing to connect to the live database "${LIVE_DB_NAME}". Development, tests and scripts ` +
      'use a database whose name ends in "_test". To run against live data, a person must set ' +
      'ALLOW_LIVE_DB=1 in server/.env.'
    );
  }
};

// Atlas never gets indexes or collections implicitly; those change only through a migration.
// A throwaway mongodb-memory-server instance may build them.
const connectOptions = ({ inMemory = false } = {}) => ({
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
  autoIndex: inMemory,
  autoCreate: inMemory,
});

const connectDB = async ({ uri = process.env.MONGODB_URI, env = process.env, inMemory = false } = {}) => {
  if (!uri || uri.trim() === '') {
    throw new DatabaseRefusedError('MONGODB_URI environment variable is missing.');
  }
  assertDatabaseAllowed(databaseNameFromUri(uri), env);

  const conn = await mongoose.connect(uri, connectOptions({ inMemory }));
  console.log(`[Database] MongoDB Connected: ${conn.connection.host}`);
  console.log(`[Database] Active Database: ${conn.connection.name}`);
  return conn;
};

mongoose.connection.on('disconnected', () => {
  console.warn('[Database Warning] MongoDB connection lost. Reconnecting...');
});

mongoose.connection.on('error', (err) => {
  console.error(`[Database Error] Runtime connection error: ${err.message}`);
});

module.exports = connectDB;
module.exports.connectDB = connectDB;
module.exports.connectOptions = connectOptions;
module.exports.databaseNameFromUri = databaseNameFromUri;
module.exports.assertDatabaseAllowed = assertDatabaseAllowed;
module.exports.DatabaseRefusedError = DatabaseRefusedError;
module.exports.LIVE_DB_NAME = LIVE_DB_NAME;
module.exports.isE2EMode = isE2EMode;
module.exports.isTestDatabaseName = isTestDatabaseName;
