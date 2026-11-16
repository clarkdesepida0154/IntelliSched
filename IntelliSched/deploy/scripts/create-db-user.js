// IntelliSched deployment kit (decision 4): the database's one user, through MongoDB's localhost
// exception, with the gateway's own MongoDB driver. Also makes the one-node replica set the gateway's
// transactions need. Run once by install.ps1:  node create-db-user.js --root <install folder>
// The user and its password come from config\server.env's MONGODB_URI (written by install.ps1);
// nothing is printed but the user name, the port and the result.
const crypto = require('crypto');
const { P, loadServerEnv, serverRequire, say, fail } = require('./kit-lib');

const REPL_SET = 'rs-intellisched';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const main = async () => {
  loadServerEnv();
  const uri = new URL(process.env.MONGODB_URI);
  const user = decodeURIComponent(uri.username);
  const pwd = decodeURIComponent(uri.password);
  const dbName = uri.pathname.replace(/^\//, '');
  const host = `127.0.0.1:${uri.port}`;
  const { MongoClient } = serverRequire('mongodb');

  // 1. The replica set (one member, this address) through the localhost exception.
  const local = await MongoClient.connect(`mongodb://${host}/?directConnection=true`, { serverSelectionTimeoutMS: 30000 });
  try {
    const admin = local.db('admin');
    let hello = await admin.command({ hello: 1 });
    if (!hello.setName) {
      say(`Starting the database's replica set ${REPL_SET} on ${host}`);
      await admin.command({ replSetInitiate: { _id: REPL_SET, members: [{ _id: 0, host }] } });
    }
    for (let i = 0; i < 120; i += 1) {
      hello = await admin.command({ hello: 1 });
      if (hello.isWritablePrimary) break;
      await sleep(500);
    }
    if (!hello.isWritablePrimary) fail('The database did not become ready within 60 seconds.');

  } finally {
    await local.close();
  }

  // 2. The user. The localhost exception lets the FIRST user be created while no user exists, but
  //    that user may only get roles of the admin database. So a temporary setup user (user
  //    administration only, a random password kept in memory) is made through the exception, signs
  //    in, creates intellisched_app with readWrite and dbAdmin on the IntelliSched database only, and
  //    is dropped again. The app user is then the only user.
  const setupUser = `intellisched_setup_${crypto.randomBytes(4).toString('hex')}`;
  const setupPwd = crypto.randomBytes(24).toString('base64url');
  let madeSetup = false;
  {
    const c = await MongoClient.connect(`mongodb://${host}/?directConnection=true`, { serverSelectionTimeoutMS: 30000 });
    try {
      await c.db('admin').command({ createUser: setupUser, pwd: setupPwd, roles: [{ role: 'userAdminAnyDatabase', db: 'admin' }] });
      madeSetup = true;
    } catch (err) {
      // A user exists already (an earlier run): the exception is closed; the app user is checked below.
      if (!/not authorized|requires authentication|Unauthorized/i.test(`${err.codeName} ${err.message}`)) throw err;
      say('The database already has a user (an earlier run); checking that the app user signs in');
    } finally {
      await c.close();
    }
  }
  if (madeSetup) {
    const enc = encodeURIComponent;
    const c = await MongoClient.connect(`mongodb://${enc(setupUser)}:${enc(setupPwd)}@${host}/?directConnection=true&authSource=admin`, { serverSelectionTimeoutMS: 30000 });
    try {
      const admin = c.db('admin');
      try {
        await admin.command({ createUser: user, pwd, roles: [{ role: 'readWrite', db: dbName }, { role: 'dbAdmin', db: dbName }] });
        say(`Created the database user ${user} (readWrite and dbAdmin on ${dbName} only)`);
      } catch (err) {
        if (err.code === 51003 || /already exists/i.test(err.message)) {
          await admin.command({ updateUser: user, pwd, roles: [{ role: 'readWrite', db: dbName }, { role: 'dbAdmin', db: dbName }] });
          say(`The database user ${user} existed; its password and roles were set again`);
        } else throw err;
      }
      await admin.command({ dropUser: setupUser });
      say('Removed the temporary setup user');
    } finally {
      await c.close();
    }
  }

  // 3. The user signs in and can write.
  const app = await MongoClient.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 30000 });
  try {
    const db = app.db(dbName);
    await db.collection('install_check').insertOne({ at: new Date() });
    await db.collection('install_check').drop();
    say(`The user ${user} signs in and writes to ${dbName}: OK`);
  } finally {
    await app.close();
  }
};

main().then(() => process.exit(0)).catch((err) => fail(`The database user could not be made: ${err.message}`));
void P;
