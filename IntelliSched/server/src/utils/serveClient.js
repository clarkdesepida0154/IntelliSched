// Phase 12 (the deployment kit, decision 3): in production the gateway serves the built web client
// (client/dist) on its own port, so the office PC runs one web address and the page calls /api on the
// same origin. Development is unchanged: without NODE_ENV=production nothing is mounted (Vite serves
// the client on its own port).
//   CLIENT_DIST_DIR   the built client's folder (the kit sets C:\IntelliSched\app\client); default
//                     <repo>/client/dist
//   HOST              the address the gateway listens on (the kit sets 127.0.0.1, so no other computer
//                     can reach it); unset = every address, as before
const fs = require('fs');
const path = require('path');
const express = require('express');

const DEFAULT_DIST = path.resolve(__dirname, '..', '..', '..', 'client', 'dist');

const clientDistDir = (env = process.env) => path.resolve(env.CLIENT_DIST_DIR || DEFAULT_DIST);

// Whether the built client is served: production only, and only when its index.html is there.
const servesClient = (env = process.env) =>
  env.NODE_ENV === 'production' && fs.existsSync(path.join(clientDistDir(env), 'index.html'));

// Mounts the static files and the single-page fallback (every GET outside /api that is no file gets
// index.html, so a reload on #/... or /some/page still opens the app). Returns the folder or null.
const mountClient = (app, env = process.env) => {
  if (!servesClient(env)) return null;
  const dir = clientDistDir(env);
  app.use(express.static(dir, { index: 'index.html', fallthrough: true }));
  app.get(/^(?!\/api(?:\/|$)).*/, (req, res, next) => {
    if (!req.accepts('html')) return next();
    res.sendFile(path.join(dir, 'index.html'));
  });
  return dir;
};

// app.listen's arguments: [port, host] when HOST is set, else [port] (every address, the old default).
const listenArgs = (env = process.env) => {
  const port = Number(env.PORT) || 5000;
  const host = String(env.HOST || '').trim();
  return host ? [port, host] : [port];
};

module.exports = { clientDistDir, servesClient, mountClient, listenArgs, DEFAULT_DIST };
