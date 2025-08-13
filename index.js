'use strict';

require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const winston = require('winston');
const crypto = require('crypto');
const TelegramBot = require('node-telegram-bot-api');
const { admin, db } = require('./firebase');

const PORT = Number(process.env.PORT || 3000);
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET_PATH = process.env.WEBHOOK_SECRET_PATH;
const PROVIDER_CALLBACK_SECRET = process.env.PROVIDER_CALLBACK_SECRET || '';
const POINTS_FOR_COMPLETION = Number(process.env.POINTS_FOR_COMPLETION || 1);
const POINTS_FOR_REFERRAL = Number(process.env.POINTS_FOR_REFERRAL || 0); // you want 0
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

if (!TELEGRAM_BOT_TOKEN) {
  console.error('FATAL: TELEGRAM_BOT_TOKEN is required');
  process.exit(1);
}
if (!WEBHOOK_SECRET_PATH) {
  console.error('FATAL: WEBHOOK_SECRET_PATH is required');
  process.exit(1);
}

const logger = winston.createLogger({
  level: LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(r => `${r.timestamp} [${r.level}] ${r.message}`)
  ),
  transports: [ new winston.transports.Console() ]
});

const app = express();
app.use(helmet());
app.use(express.json({ limit: '512kb' }));

// Telegram bot (webhook mode; we will setWebhook in Phase 2 with curl)
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
let BOT_USERNAME = null;

// Helper: deep-link for referrals requires bot username
async function ensureBotUsername() {
  if (BOT_USERNAME) return BOT_USERNAME;
  const me = await bot.getMe();
  BOT_USERNAME = me.username;
  return BOT_USERNAME;
}

// Build referral deep link t.me/<bot>?start=<refId>
async function buildReferralLink(refId) {
  const uname = await ensureBotUsername();
  return `https://t.me/${uname}?start=${encodeURIComponent(refId)}`;
}

// Offer link (replace with real provider link)
function buildOfferLink(userId) {
  // put your real offer provider link here; include userId so provider can callback
  return `https://your-offer-provider.example.com/install?ref=${encodeURIComponent(userId)}`;
}

// Save user on /start, capture referrer once
async function upsertUser(chatId, username, referrerId) {
  const userRef = db.ref(`users/${chatId}`);
  await userRef.transaction(current => {
    if (current === null) {
      return {
        username: username || null,
        joinedAt: admin.database.ServerValue.TIMESTAMP,
        referrer: referrerId || null,
        points: 0,
        completedInstalls: 0
      };
    }
    if (!current.referrer && referrerId) current.referrer = referrerId;
    if (!current.username && username) current.username = username;
    return current;
  });
}

// keep a single leaderboard: points map (userId -> { points, username, updatedAt })
async function bumpLeaderboard(userId, delta, username) {
  const lbRef = db.ref(`leaderboard/${userId}`);
  await lbRef.transaction(cur => {
    if (!cur) return { points: delta, username: username || null, updatedAt: admin.database.ServerValue.TIMESTAMP };
    cur.points = (cur.points || 0) + delta;
    if (username && !cur.username) cur.username = username;
    cur.updatedAt = admin.database.ServerValue.TIMESTAMP;
    return cur;
  });
}

// /start with optional ref code
bot.onText(/\/start(?:\s+([^\s]+))?/, async (msg, match) => {
  const chatId = String(msg.chat.id);
  const ref = match && match[1] ? String(match[1]) : null;
  const username = (msg.from && (msg.from.username || `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim())) || null;

  logger.info(`START from ${chatId} ref=${ref} user=${username}`);

  // prevent self-referral
  const referrerId = (ref && ref !== chatId) ? ref : null;
  await upsertUser(chatId, username, referrerId);

  const offer = buildOfferLink(chatId);
  const myRefLink = await buildReferralLink(chatId);

  const text =
`Welcome!
Install the app from this link. When the provider confirms completion, your referrer (if any) will get +1 point on the leaderboard.

Install link:
${offer}

Your referral link:
${myRefLink}

Rules:
• Only completed installs add points.
• Points are credited to the referrer ONLY.
• No multi-level — each user counts only for the link they used.`;

  try {
    await bot.sendMessage(chatId, text, { disable_web_page_preview: true });
  } catch (e) {
    logger.warn(`sendMessage failed to ${chatId}: ${e.message}`);
  }
});

// /ref command: return your referral link
bot.onText(/\/ref/, async (msg) => {
  const chatId = String(msg.chat.id);
  const link = await buildReferralLink(chatId);
  await bot.sendMessage(chatId, `Your referral link:\n${link}`, { disable_web_page_preview: true });
});

// /leaderboard: show top 10
bot.onText(/\/leaderboard/, async (msg) => {
  const chatId = String(msg.chat.id);
  const snap = await db.ref('leaderboard').orderByChild('points').limitToLast(10).once('value');
  const obj = snap.val() || {};
  const arr = Object.keys(obj).map(k => ({ userId: k, ...obj[k] })).sort((a,b) => (b.points||0) - (a.points||0));

  if (!arr.length) {
    return bot.sendMessage(chatId, 'Leaderboard is empty yet. Start sharing your link!');
  }

  const lines = arr.map((it, i) => {
    const name = it.username ? `@${it.username}` : it.userId;
    return `${i+1}. ${name} — ${it.points} pts`;
  });
  await bot.sendMessage(chatId, `Top 10 Referees (by completed installs):\n\n${lines.join('\n')}`);
});

// Provider callback: POST /offers/callback
// expected JSON: { installId, userRefId, providerStatus }
// HMAC header: x-provider-signature = hex( HMAC_SHA256(body, PROVIDER_CALLBACK_SECRET) )
app.post('/offers/callback', async (req, res) => {
  try {
    if (PROVIDER_CALLBACK_SECRET) {
      const sig = req.get('x-provider-signature') || '';
      const bodyRaw = JSON.stringify(req.body);
      const expected = crypto.createHmac('sha256', PROVIDER_CALLBACK_SECRET).update(bodyRaw).digest('hex');
      if (!sig || expected.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
        logger.warn('Invalid provider signature');
        return res.status(403).json({ ok: false });
      }
    }

    const { installId, userRefId, providerStatus } = req.body || {};
    if (!installId || !userRefId) {
      return res.status(400).json({ ok: false, reason: 'missing fields' });
    }

    const status = String(providerStatus || 'completed').toLowerCase();
    const okStatuses = new Set(['completed','approved','paid','success']);
    if (!okStatuses.has(status)) {
      logger.info(`callback ignored non-success status=${status}`);
      return res.json({ ok: true, ignored: true });
    }

    // idempotency: process installId once
    const instRef = db.ref(`installs/${installId}`);
    const instSnap = await instRef.once('value');
    if (instSnap.exists()) {
      logger.info(`install already processed ${installId}`);
      return res.json({ ok: true, alreadyProcessed: true });
    }
    await instRef.set({
      installId,
      userRefId: String(userRefId),
      providerStatus: status,
      at: admin.database.ServerValue.TIMESTAMP
    });

    // get completed user -> find their referrer
    const userSnap = await db.ref(`users/${userRefId}`).once('value');
    if (!userSnap.exists()) {
      logger.warn(`user not found for completion ${userRefId}`);
      return res.json({ ok: true, note: 'user-not-found' });
    }
    const user = userSnap.val();
    const referrerId = user.referrer || null;

    // mark completed count for the user (no points to user themselves)
    await db.ref(`users/${userRefId}`).transaction(cur => {
      if (!cur) return { completedInstalls: 1 };
      cur.completedInstalls = (cur.completedInstalls || 0) + 1;
      return cur;
    });

    // give +1 to referrer ONLY (your rule)
    if (referrerId && referrerId !== String(userRefId)) {
      // increment referrer's points
      const refSnap = await db.ref(`users/${referrerId}`).once('value');
      const refUser = refSnap.val() || {};
      await db.ref(`users/${referrerId}`).transaction(cur => {
        if (!cur) return { points: POINTS_FOR_COMPLETION };
        cur.points = (cur.points || 0) + POINTS_FOR_COMPLETION;
        return cur;
      });
      await bumpLeaderboard(referrerId, POINTS_FOR_COMPLETION, refUser.username || null);
      logger.info(`credited referrer ${referrerId} +${POINTS_FOR_COMPLETION} for user ${userRefId}`);
    } else {
      logger.info(`no referrer to credit for user ${userRefId}`);
    }

    return res.json({ ok: true });
  } catch (err) {
    logger.error('callback error: ' + err.stack);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Telegram webhook endpoint: Telegram will POST updates here
app.post(`/${WEBHOOK_SECRET_PATH}`, (req, res) => {
  try {
    // let the bot lib parse and handle the update
    bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (e) {
    logger.error('processUpdate failed: ' + e.message);
    res.sendStatus(200); // keep 200 so Telegram doesn't retry storm
  }
});

// simple health + public leaderboard API
app.get('/', (req, res) => res.json({ ok: true, service: 'telebot-referral' }));

app.get('/leaderboard/top/:n', async (req, res) => {
  const n = Math.min(100, Math.max(1, parseInt(req.params.n || '50', 10)));
  const snap = await db.ref('leaderboard').orderByChild('points').limitToLast(n).once('value');
  const obj = snap.val() || {};
  const arr = Object.keys(obj).map(k => ({ userId: k, ...obj[k] })).sort((a,b) => (b.points||0) - (a.points||0));
  res.json({ ok: true, top: arr });
});

app.get('/admin/leaderboard/top50', async (req, res) => {
  if (!ADMIN_SECRET) return res.status(403).json({ ok: false, e: 'no-admin-secret' });
  const provided = req.get('x-admin-secret') || '';
  if (provided !== ADMIN_SECRET) return res.status(403).json({ ok: false });
  const snap = await db.ref('leaderboard').orderByChild('points').limitToLast(50).once('value');
  const obj = snap.val() || {};
  const arr = Object.keys(obj).map(k => ({ userId: k, ...obj[k] })).sort((a,b) => (b.points||0) - (a.points||0));
  res.json({ ok: true, top: arr });
});

app.listen(PORT, async () => {
  logger.info(`server listening on ${PORT}`);
  try {
    await ensureBotUsername();
    logger.info(`bot username = @${BOT_USERNAME}`);
  } catch (e) {
    logger.warn('getMe failed (webhook not set yet): ' + e.message);
  }
});
