// The demo's own MongoDB: one mongod (mongodb-memory-server-core, from server/node_modules) run as a
// one-node replica set, because the lock routes use transactions. Its data lives in .demo-data/mongo,
// so the demo database survives a restart. Only 127.0.0.1; never Atlas.
//
// MongoMemoryReplSet is not used: when its data folder already holds a replica set it re-applies the
// stored configuration, which names the old port and breaks when the port had to change. Here the
// set is initiated on the first start, and re-pointed at the current port (a forced reconfig) when
// the stored member names another one.
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { SERVER_DIR } = require('./paths');

const serverRequire = createRequire(path.join(SERVER_DIR, 'package.json'));
const { MongoMemoryServer } = serverRequire('mongodb-memory-server-core');
const { MongoClient } = serverRequire('mongodb');

const REPL_SET = 'rs-demo';
// The mongod binary the server tests already downloaded (MongoDB 7.0, cached per project).
const BINARY_DIR = path.join(SERVER_DIR, 'node_modules', '.cache', 'mongodb-memory-server');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Starts mongod on 127.0.0.1:port with its data in dbPath. mongod's output is appended to logFile.
// Returns { server, port, pid, killerPid, uriFor(dbName), stop() }; stop() keeps the data folder.
const startMongo = async ({ dbPath, port, logFile }) => {
  fs.mkdirSync(dbPath, { recursive: true });
  const server = await MongoMemoryServer.create({
    instance: {
      dbPath,
      port,
      ip: '127.0.0.1',
      storageEngine: 'wiredTiger',
      replSet: REPL_SET, // also makes stop() shut mongod down cleanly before killing it
      portGeneration: false,
      launchTimeout: 120000
    },
    binary: { downloadDir: BINARY_DIR }
  });
  const instance = server.instanceInfo.instance;
  const log = fs.createWriteStream(logFile, { flags: 'a' });
  instance.on('instanceSTDOUT', line => log.write(`${line}\n`));
  instance.on('instanceSTDERR', line => log.write(`${line}\n`));

  const host = `127.0.0.1:${port}`;
  const stop = async () => {
    await server.stop({ doCleanup: false }); // the data folder is kept
    log.end();
  };
  try {
    await becomePrimary(host);
  } catch (err) {
    await stop().catch(() => {});
    throw err;
  }

  return {
    server,
    port,
    pid: instance.mongodProcess?.pid,
    killerPid: instance.killerProcess?.pid,
    uriFor: (dbName) => `mongodb://${host}/${dbName}?replicaSet=${REPL_SET}`,
    stop
  };
};

// Initiates the one-node replica set, or points its member at this address, then waits until the
// node is a writable primary.
const becomePrimary = async (host) => {
  const client = await MongoClient.connect(`mongodb://${host}/?directConnection=true`, { serverSelectionTimeoutMS: 15000 });
  try {
    const admin = client.db('admin');
    const stored = await client.db('local').collection('system.replset').findOne({});
    if (!stored) {
      await admin.command({ replSetInitiate: { _id: REPL_SET, members: [{ _id: 0, host }] } });
    } else if (stored.members.length !== 1 || stored.members[0].host !== host) {
      // The port changed since the last run: point the one member at this address.
      const config = { ...stored, version: stored.version + 1, members: [{ ...stored.members[0], host }] };
      delete config.term;
      // Until mongod has loaded its stored configuration (it first tries to reach the old address,
      // which can take half a minute), it answers "no replset config has been received".
      const deadline = Date.now() + 120000;
      for (;;) {
        try {
          await admin.command({ replSetReconfig: config, force: true });
          break;
        } catch (err) {
          if (err.codeName !== 'NotYetInitialized' || Date.now() > deadline) throw err;
          await sleep(500);
        }
      }
    }
    // Wait until this node is a writable primary (single node: a few seconds at most).
    const deadline = Date.now() + 120000;
    for (;;) {
      const hello = await admin.command({ hello: 1 });
      if (hello.isWritablePrimary) break;
      if (Date.now() > deadline) throw new Error(`MongoDB on ${host} did not become a writable primary within 2 minutes.`);
      await sleep(250);
    }
  } finally {
    await client.close();
  }
};

// Runs fn(db) on one database of the demo's mongod and always closes the connection.
const withDatabase = async (uri, fn) => {
  const client = await MongoClient.connect(uri, { serverSelectionTimeoutMS: 15000 });
  try {
    return await fn(client.db());
  } finally {
    await client.close();
  }
};

module.exports = { startMongo, withDatabase, REPL_SET };
