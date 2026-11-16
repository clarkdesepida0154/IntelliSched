const { maskRatings, ratingsHidden } = require('../utils/presentation');

// Phase 7, presentation mode (utils/presentation.js): mounted once in app.js, right after the sign-in
// check, for every /api route. While "Show evaluation ratings on screen" is off, the answer's JSON is
// masked before it leaves, so no rating reaches the browser whatever the route. It never refuses a
// request. When the setting cannot be read, the answer is masked (a rating is never shown by mistake).
exports.presentationMode = async (req, res, next) => {
  let hidden = true;
  try {
    hidden = await ratingsHidden();
  } catch (err) {
    console.error(`[Presentation mode] The setting could not be read, so this answer hides the ratings: ${err.message}`);
  }
  if (hidden) {
    const send = res.json.bind(res);
    res.json = (body) => send(body === undefined ? body : maskRatings(JSON.parse(JSON.stringify(body))));
  }
  next();
};
