import axios from 'axios';
import { topicsOfWrite } from '../utils/dataTopics';
import { CLIENT_ID, announceChange } from '../utils/dataChanges';

const api = axios.create({
  // Phase 12: a production build (the deployment kit) calls the gateway that served the page, on the
  // same address (relative /api); development keeps its own gateway address.
  // VITE_API_BASE_URL wins when set.
  baseURL: import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? 'http://localhost:5000/api' : '/api'),
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
    // Phase 8 Part 8 (decision 6): names this tab in the gateway's change feed, so its own writes are
    // not announced to it twice.
    'X-Client-Id': CLIENT_ID,
  },
});

// Centralized error logging interceptor. Phase 8 Part 8 (decision 6, live updates): a successful write
// announces the data it changed on this page at once (utils/dataTopics.js), tagged with the caller's
// `origin` (a config field: api.post(url, body, { origin: 'by-class' })).
api.interceptors.response.use(
  (response) => {
    const { method, url, origin } = response.config || {};
    const topics = topicsOfWrite(method, url);
    if (topics.length) announceChange(topics, { origin: origin || null });
    return response;
  },
  (error) => {
    const message =
      error.response?.data?.message ||
      error.message ||
      'Network communication failure with Express Gateway.';
    console.error('[API Gateway Error]:', message);
    return Promise.reject(error);
  }
);

export default api;
