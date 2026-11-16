// Folders the demo uses. Everything it writes is under .demo-data/ (gitignored).
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEMO_DATA = path.join(REPO_ROOT, '.demo-data');

module.exports = {
  REPO_ROOT,
  SERVER_DIR: path.join(REPO_ROOT, 'server'),
  CLIENT_DIR: path.join(REPO_ROOT, 'client'),
  BACKEND_DIR: path.resolve(REPO_ROOT, '..', 'intellisched_backend'),
  DEMO_DATA,
  MONGO_DIR: path.join(DEMO_DATA, 'mongo'),
  LOG_DIR: path.join(DEMO_DATA, 'logs'),
  // The gateway runs from here, an empty folder, so dotenv finds no .env (never server/.env).
  GATEWAY_CWD: path.join(DEMO_DATA, 'gateway'),
  SECRETS_FILE: path.join(DEMO_DATA, 'demo-secrets.json'),
  // Written while a demo runs: its PID, ports and the PIDs it started (read by check.js).
  RUN_FILE: path.join(DEMO_DATA, 'run.json')
};
