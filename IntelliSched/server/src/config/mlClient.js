const axios = require('axios');

// In E2E mode only an explicitly named test instance is called (E2E_FASTAPI_URL), never the service
// named in server/.env, which may be connected to live data.
const IS_E2E = process.env.E2E_MODE === '1';
const FASTAPI_URL = IS_E2E
  ? (process.env.E2E_FASTAPI_URL || '')
  : (process.env.PYTHON_ML_SERVICE_URL || process.env.FASTAPI_URL || 'http://127.0.0.1:8001');
const API_KEY = process.env.PYTHON_ML_API_KEY || process.env.ML_SERVICE_API_KEY || process.env.FASTAPI_API_KEY;

if (!API_KEY || API_KEY.trim() === '') {
  console.error('[Security Fatal] Neither PYTHON_ML_API_KEY nor FASTAPI_API_KEY is configured in server/.env.');
}

const mlClient = axios.create({
  baseURL: FASTAPI_URL,
  timeout: 180000, // 3 minutes for recommendations, roster sync and retraining
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': API_KEY || ''
  }
});

mlClient.interceptors.request.use(
  (config) => {
    if (!config.headers['x-api-key']) {
      return Promise.reject(new Error('Outbound microservice request blocked: Missing x-api-key header.'));
    }
    return config;
  },
  (error) => Promise.reject(error)
);

mlClient.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error.response?.status;
    if (status === 401 || status === 403) {
      console.error(`[Microservice Security Error ${status}]: FastAPI rejected x-api-key. Verify that server/.env PYTHON_ML_API_KEY matches Clark's ADMIN_API_KEY.`);
    } else if (error.code === 'ECONNREFUSED') {
      console.error(`[Microservice Gateway Error]: Connection refused at ${FASTAPI_URL}. Ensure FastAPI is operational on port 8001.`);
    }
    return Promise.reject(error);
  }
);

// A GA run is a background job (Phase 2 Step 4): each call to the job endpoints is short, so no
// call waits for the run itself.
mlClient.BASE_URL = FASTAPI_URL;

// E2E mode talks only to a FastAPI service on this computer: a remote one (e.g. a dev tunnel) may be
// connected to the live database. Returns an error message, or null when the target is allowed.
mlClient.e2eTargetProblem = (url = FASTAPI_URL) => {
  if (!url) return 'E2E mode needs E2E_FASTAPI_URL: the local FastAPI service started with the _test database.';
  const host = (/^https?:\/\/(\[[^\]]+\]|[^/:]+)/i.exec(String(url)) || [])[1] || '';
  return ['localhost', '127.0.0.1', '[::1]'].includes(host.toLowerCase())
    ? null
    : `E2E mode refuses the FastAPI service at ${url}: set E2E_FASTAPI_URL to a local service (http://127.0.0.1:<port>) that uses the _test database.`;
};

module.exports = mlClient;