require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const connectDB = require('./config/db');
const { isE2EMode } = require('./config/db');

// Fail-closed environment validation
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.trim() === '') {
  console.error('[Server Fatal] JWT_SECRET is unset. Exiting process.');
  process.exit(1);
}
if (!process.env.MONGODB_URI || process.env.MONGODB_URI.trim() === '') {
  console.error('[Server Fatal] MONGODB_URI is unset. Exiting process.');
  process.exit(1);
}

// Middleware Imports
const { protect, requireOwnPassword } = require('./middleware/authMiddleware');
const { createLoginLimiter } = require('./middleware/loginLimiter');
const { presentationMode } = require('./middleware/presentationMode');
const changeFeed = require('./utils/changeFeed');

// Route Imports
const authRoutes = require('./routes/authRoutes');
const academicRoutes = require('./routes/academicRoutes');
const schedulerRoutes = require('./routes/schedulerRoutes');
const policyRoutes = require('./routes/policyRoutes');
const referenceListRoutes = require('./routes/referenceListRoutes');
const outputSettingsRoutes = require('./routes/outputSettingsRoutes');
const userRoutes = require('./routes/userRoutes');
const auditRoutes = require('./routes/auditRoutes');
const systemRoutes = require('./routes/systemRoutes');
const academicCalendarRoutes = require('./routes/academicCalendarRoutes');

const app = express();

// Connect to MongoDB. A refused target (the live database without ALLOW_LIVE_DB=1) or a failed
// first connection stops the gateway.
// E2E mode: the gateway, its database and the FastAPI service it calls are all test instances.
if (isE2EMode()) {
  const problem = require('./config/mlClient').e2eTargetProblem();
  if (problem) {
    console.error(`[Startup Refused] ${problem}`);
    process.exit(1);
  }
}

connectDB()
  // GA runs the gateway was following when it stopped are followed again (or marked failed).
  .then(() => require('./utils/gaRuns').recoverRuns())
  .then((n) => { if (n) console.log(`[GA runs] Following ${n} run(s) left open by the last gateway start.`); })
  // Phase 11.3: the daily backup check (every 10 minutes; BACKUP_TIMER=off switches it off).
  .then(() => { require('./backup/scheduler').start(); })
  // Phase 12.1 (decision 4): the kit's supervisor says when the last session ended uncleanly (a power
  // cut, Windows shut down while it ran). If data changed since the last backup, back up now, in the
  // background: the sign-in page is never kept waiting.
  .then(() => {
    if (process.env.INTELLISCHED_UNCLEAN_END !== '1') return;
    setTimeout(() => {
      require('./backup/operations').backupIfChanged({ reason: 'unclean' })
        .then(r => console.log(`[Backup] after the unclean end: ${r.result}${r.message ? ` (${r.message})` : ''}`))
        .catch(err => console.error('[Backup] after the unclean end:', err.message));
    }, 5000).unref?.();
  })
  .catch((error) => {
    console.error(`[Database Fatal] ${error.message}`);
    process.exit(1);
  });

// CORS Configuration
app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:5173',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  // Phase 8 Part 8 (decision 6): X-Client-Id names the tab a write came from (the change feed).
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Client-Id'],
  // The exports (Phase 8 Part 2) stream files: the page reads the file's name and page count from
  // these headers.
  exposedHeaders: ['Content-Disposition', 'X-Export-Pages', 'X-Export-Fonts-Substituted']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate Limiting Policies
// Sign-in: 10 FAILED attempts per 15 minutes per address (successful sign-ins are not counted).
const authLimiter = createLoginLimiter();

const heavyOpLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 12, // Limit intensive computation calls
  message: { success: false, message: 'Optimization pipeline busy. Please slow down requests.' },
  standardHeaders: true,
  legacyHeaders: false
});

// 1. PUBLIC ENDPOINTS
// Live Gateway Health Probe targeting port 8001
app.get('/api/health', async (req, res) => {
  const nodeStart = performance.now();
  // The same service the scheduler routes call.
  const fastApiBaseUrl = require('./config/mlClient').BASE_URL;

  const isMongoConnected = mongoose.connection.readyState === 1;
  const mongoStatus = isMongoConnected ? 'Online' : 'Offline';
  // Measured, never assumed: one ping round trip.
  let mongoLatency = 'N/A';
  if (isMongoConnected) {
    try {
      const pingStart = performance.now();
      await mongoose.connection.db.admin().ping();
      mongoLatency = `${Math.round(performance.now() - pingStart)}ms`;
    } catch {
      mongoLatency = 'Timeout';
    }
  }

  let fastApiStatus = 'Offline';
  let fastApiLatency = 'N/A';
  let fastApiDetails = null;
  let fastApiDatabase = null;

  try {
    const pyStart = performance.now();
    const pyRes = await axios.get(`${fastApiBaseUrl}/api/health`, { timeout: 3000 });
    fastApiLatency = `${Math.round(performance.now() - pyStart)}ms`;
    fastApiStatus = pyRes.data?.status === 'online' ? 'Online' : 'Standby';
    fastApiDetails = pyRes.data?.engines || null;
    fastApiDatabase = pyRes.data?.database || null;
  } catch (err) {
    fastApiStatus = 'Standby';
  }

  const gatewayLatency = `${Math.round(performance.now() - nodeStart)}ms`;
  // Phase 12.1 (decision 4): when it was last used, for the kit's supervisor.
  const activityState = isMongoConnected ? await require('./backup/activity').state().catch(() => null) : null;

  res.status(200).json({
    status: isMongoConnected ? 'Operational' : 'Degraded',
    service: 'IntelliSched API Gateway',
    // Playwright's global setup refuses to run unless mode is "e2e" and the database ends in _test.
    mode: isE2EMode() ? 'e2e' : 'standard',
    database: isMongoConnected ? mongoose.connection.name : null,
    timestamp: new Date().toISOString(),
    // Phase 12.2 (decision 3): whether the gateway runs as administrator (it never should), and the
    // PDF browser's warm-up ('off' | 'pending' | 'ok' | 'failed').
    elevated: require('./utils/elevation').processIdentity().elevated,
    pdfWarmUp: require('./exports/pdf').warmUpState().state,
    // The services' names in plain words (Phase 3 Step 8); the keys say which part each one is.
    activity: activityState,
    services: {
      node: {
        name: 'Web server (gateway)',
        status: 'Online',
        latency: gatewayLatency
      },
      python: {
        name: 'Scheduling and ranking service',
        status: fastApiStatus,
        latency: fastApiLatency,
        database: fastApiDatabase,
        engines: fastApiDetails
      },
      mongo: {
        name: 'Database',
        status: mongoStatus,
        latency: mongoLatency
      }
    }
  });
});

// Phase 12.2 (decision 3): the kit's self-test checks that depend on who runs the gateway (who it runs
// as, one PDF, Back up now); local and secret-guarded, never a user request (routes/kitSelfTestRoutes.js).
const kitSelfTestRoutes = require('./routes/kitSelfTestRoutes').router;
app.use('/api/kit/selftest', kitSelfTestRoutes);

// Phase 12.1 (decision 4): the time of the last real user request (not the health route, the live-update
// feed or the kit's own checks), which the kit's supervisor reads to close IntelliSched when unused.
const activity = require('./backup/activity');
app.use('/api', activity.track);

// Apply rate limiting to authentication entry point
app.use('/api/auth/login', authLimiter);
app.use('/api/auth', authRoutes);

// 2. PROTECTED BUSINESS & MUTATION ROUTES
// One sign-in check for every /api route below. What a signed-in user may do is checked on each write
// route, from the one permission map (middleware/roles.js requirePermission, utils/permissions.js;
// Phase 3 Step 6); every signed-in role may read. No guard is mounted on the bare /api prefix: it
// would also run on every request the routers below it do not handle. Phase 7: presentation mode masks
// the evaluation ratings in every answer while "Show evaluation ratings on screen" is off; it never refuses.
app.use('/api', protect);
// Phase 12.1: nothing opens until a starting password is changed (POST /api/auth/change-password).
app.use('/api', requireOwnPassword);
app.use('/api', presentationMode);
// Phase 8 Part 8 (decision 6): live updates — every successful write's topics join the change feed,
// which the open tabs read about every 2 seconds.
app.use('/api', changeFeed.trackWrites);
app.get('/api/changes', changeFeed.getChanges);
app.use('/api/schedule/generate', heavyOpLimiter);
app.use('/api/schedule/retrain', heavyOpLimiter);
app.use('/api', academicRoutes);
app.use('/api', schedulerRoutes);
app.use('/api', policyRoutes);
app.use('/api', referenceListRoutes);
app.use('/api', outputSettingsRoutes);
app.use('/api', userRoutes);
app.use('/api', auditRoutes);
app.use('/api', systemRoutes);
app.use('/api', academicCalendarRoutes);

// Phase 12: in production the built web client is served from this port (utils/serveClient.js);
// development is unchanged.
const { mountClient, listenArgs } = require('./utils/serveClient');
mountClient(app);

// Centralized 404 Handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Endpoint not found: ${req.method} ${req.originalUrl}`
  });
});

// Centralized Error Handler (suppresses internal stacks in production)
app.use((err, req, res, next) => {
  // Plain words for the page in every mode; the raw error goes to the server log (utils/messages.js).
  res.status(err.status || 500).json({
    success: false,
    message: require('./utils/messages').plainMessage(err, 'Something went wrong on the server. Try again; if it keeps happening, tell the College Secretary.', { label: '[Server Error]' })
  });
});

// Phase 12: HOST (the kit sets 127.0.0.1) limits the address; unset listens on every address as before.
const listenAt = listenArgs();
const [PORT, HOST] = listenAt;
app.listen(...listenAt, () => {
  console.log(`[Express Gateway] Server running on http://${HOST || 'localhost'}:${PORT}`);
  console.log(`[Express Gateway] FastAPI Microservice target: ${require('./config/mlClient').BASE_URL}`);
  // Phase 12.2 (decision 2): warm the PDF browser in the background (one tiny blank PDF), so the
  // user's first export is not the cold start. On in production (the kit); PDF_WARMUP=on|off overrides.
  // It never delays the sign-in page; its failure is only logged.
  const id = require('./utils/elevation').processIdentity();
  console.log(`[Express Gateway] Runs as ${id.domain ? `${id.domain}\\` : ''}${id.user || 'unknown'}, ${id.elevated === true ? 'ELEVATED (administrator)' : id.elevated === false ? 'not elevated' : 'elevation unknown'}`);
  const warm = process.env.PDF_WARMUP ? process.env.PDF_WARMUP === 'on' : process.env.NODE_ENV === 'production';
  if (warm) setTimeout(() => { require('./exports/pdf').warmUp(); }, 2000).unref?.();
});

module.exports = app;