const rateLimit = require('express-rate-limit');

// The sign-in throttle: at most `max` FAILED sign-ins per window from one address. A successful
// sign-in is not counted (skipSuccessfulRequests), so a user who signs in often is never locked out;
// only repeated wrong passwords are. Once the limit is reached, every sign-in from that address is
// refused until the window ends, and the message says when to try again.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;

const pad = (n) => String(n).padStart(2, '0');
const clockTime = (date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;

const createLoginLimiter = ({ windowMs = LOGIN_WINDOW_MS, max = LOGIN_MAX_FAILURES } = {}) => rateLimit({
  windowMs,
  limit: max,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    const resetTime = req.rateLimit?.resetTime instanceof Date ? req.rateLimit.resetTime : new Date(Date.now() + windowMs);
    const minutes = Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 60000));
    res.status(options.statusCode).json({
      success: false,
      code: 'LOGIN_THROTTLED',
      message: `Too many failed sign-in attempts from this address. Try again at ${clockTime(resetTime)} (in about ${minutes} minute${minutes === 1 ? '' : 's'}).`,
      retryAt: resetTime.toISOString()
    });
  }
});

module.exports = { createLoginLimiter, LOGIN_WINDOW_MS, LOGIN_MAX_FAILURES };
