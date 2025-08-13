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
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID ? String(process.env.ADMIN_CHAT_ID) : null;

if (!TELEGRAM_BOT_TOKEN) {
  console.error('FATAL: TELEGRAM_BOT_TOKEN is required'); process.exit(1);
}
if (!WEBHOOK_SECRET_PATH) {
  console.error('FATAL: WEBHOOK_SECRET_PATH is required'); process.exit(1);
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

// Telegram bot in webhook mode (no polling)
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
let BOT_USERNAME = null;

async function ensureBotUsername() {
  if (BOT_USERNAME) return BOT_USERNAME;
  const me = await bot.getMe();
  BOT_USERNAME = me.username;
  return BOT_USERNAME;
}

// build referral deep link: t.me/<bot>?start=<refId>
async function buildReferralLink(refId) {
  const uname = await ensureBotUsername();
  return `https://t.me/${uname}?start=${encodeURIComponent(refId)}`;
}

// Replace with your real offer provider link (include userRefId so provider can identify)
function buildOfferLink(userRefId) {
  return `https://your-offer-provider.example.com/install?user=${encodeURIComponent(userRefId)}`;
}

// create/update a user on first contact; attach referrer once (no change later)
async function upsertUser(userId, username, referrerId) {
  const userRef = db.ref(`users/${userId}`);
  await userRef.transaction(current => {
    if (current === null) {
      return {
        id: userId,
        username: username || null,
        joinedAt: admin.database.ServerValue.TIMESTAMP,
        referrer: referrerId || null,
        points: 0,
        completedInstalls: 0,
        taskCompleted: false
      };
    }
    if (!current.referrer && referrerId) current.referrer = referrerId;
    if (!current.username && username) current.username = username;
    return current;
  });
}

// update single global leaderboard: leaderboard/<userId> -> { points, username, updatedAt }
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

// /start with optional referral code
bot.onText(/\/start(?:\s+([^\s]+))?/, async (msg, match) => {
  const chatId = String(msg.chat.id);
  const refCode = match && match[1] ? String(match[1]) : null;
  const username = (msg.from && (msg.from.username || `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim())) || null;

  const referrerId = (refCode && refCode !== chatId) ? refCode : null; // avoid self-ref

  await upsertUser(chatId, username, referrerId);

  const offerLink = buildOfferLink(chatId);
  const myRefLink = await buildReferralLink(chatId);

  const text = [
    '🚀 Welcome!',
    '',
    '→ Install the app from this link. When the provider confirms completion, your *referrer* gets +1 on the leaderboard.',
    '',
    `📲 Install link:\n${offerLink}`,
    '',
    `🔗 Your referral link:\n${myRefLink}`,
    '',
    'Rules:',
    '• Only completed installs add points.',
    '• Points go to the *direct referrer* only.',
    '• No multi-level: if A refers B and B refers C, only B can earn from C.'
  ].join('\n');

  try {
    await bot.sendMessage(chatId, text, { disable_web_page_preview: true, parse_mode: 'Markdown' });
  } catch (e) {
    logger.warn(`sendMessage failed to ${chatId}: ${e.message}`);
  }
});

// show your referral link
bot.onText(/\/ref$/, async (msg) => {
  const chatId = String(msg.chat.id);
  const link = await buildReferralLink(chatId);
  await bot.sendMessage(chatId, `🔗 Your referral link:\n${link}`, { disable_web_page_preview: true });
});

// /leaderboard (top 50)
bot.onText(/\/leaderboard$/, async (msg) => {
  const chatId = String(msg.chat.id);
  const snap = await db.ref('leaderboard').orderByChild('points').limitToLast(50).once('value');
  const obj = snap.val() || {};
  const arr = Object.keys(obj).map(k => ({ userId: k, ...obj[k] })).sort((a,b) => (b.points||0) - (a.points||0));

  if (!arr.length) return bot.sendMessage(chatId, '🏁 Leaderboard is empty. Share your link!');

  const lines = arr.map((it, i) => {
    const name = it.username ? `@${it.username}` : it.userId;
    return `${i+1}. ${name} — ${it.points} pts`;
  });
  await bot.sendMessage(chatId, `🏆 Top 50 Referrers (completed installs only):\n\n${lines.join('\n')}`);
});

// admin-only broadcast: /broadcast <text>
bot.onText(/\/broadcast\s+([\s\S]+)/, async (msg, match) => {
  if (!ADMIN_CHAT_ID || String(msg.chat.id) !== ADMIN_CHAT_ID) return;
  const text = match[1].trim();
  const snap = await db.ref('users').once('value');
  const users = snap.val() || {};
  for (const uid of Object.keys(users)) {
    try { await bot.sendMessage(uid, text); } catch (e) { logger.warn(`broadcast to ${uid} failed: ${e.message}`); }
  }
  await bot.sendMessage(ADMIN_CHAT_ID, '✅ Broadcast sent.');
});

// Telegram webhook endpoint
app.post(`/${WEBHOOK_SECRET_PATH}`, (req, res) => {
  try {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (e) {
    logger.error('processUpdate failed: ' + e.message);
    res.sendStatus(200);
  }
});

// Provider callback (HMAC verified)
// expected JSON: { installId, userRefId, providerStatus }
// header: x-provider-signature = hex(HMAC_SHA256(rawBody, PROVIDER_CALLBACK_SECRET))
app.post('/offers/callback', express.json({ verify: rawSaver }), async (req, res) => {
  try {
    if (!PROVIDER_CALLBACK_SECRET) return res.status(500).json({ ok:false, error:'provider secret not set' });
    const sig = req.get('x-provider-signature') || '';
    const expected = crypto.createHmac('sha256', PROVIDER_CALLBACK_SECRET)
      .update(req.rawBody || JSON.stringify(req.body || {}))
      .digest('hex');
    if (!sig || expected.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
      return res.status(403).json({ ok:false, error:'bad signature' });
    }

    const { installId, userRefId, providerStatus } = req.body || {};
    if (!installId || !userRefId) return res.status(400).json({ ok:false, error:'missing fields' });

    const status = String(providerStatus || 'completed').toLowerCase();
    const okStatuses = new Set(['completed','approved','paid','success']);
    if (!okStatuses.has(status)) return res.json({ ok:true, ignored:true });

    // idempotency
    const instRef = db.ref(`installs/${installId}`);
    const instSnap = await instRef.once('value');
    if (instSnap.exists()) return res.json({ ok:true, alreadyProcessed:true });
    await instRef.set({ installId, userRefId: String(userRefId), providerStatus: status, at: admin.database.ServerValue.TIMESTAMP });

    // load completed user
    const userRef = db.ref(`users/${userRefId}`);
    const userSnap = await userRef.once('value');
    if (!userSnap.exists()) return res.json({ ok:true, note:'user-not-found' });
    const user = userSnap.val();

    // mark their personal completion count
    await userRef.transaction(cur => {
      if (!cur) return { completedInstalls: 1, taskCompleted: true };
      cur.completedInstalls = (cur.completedInstalls || 0) + 1;
      cur.taskCompleted = true;
      return cur;
    });

    // credit ONLY the direct referrer
    const referrerId = user.referrer ? String(user.referrer) : null;
    if (referrerId && referrerId !== String(userRefId)) {
      const refSnap = await db.ref(`users/${referrerId}`).once('value');
      const refUser = refSnap.val() || {};
      await db.ref(`users/${referrerId}`).transaction(cur => {
        if (!cur) return { points: POINTS_FOR_COMPLETION };
        cur.points = (cur.points || 0) + POINTS_FOR_COMPLETION;
        return cur;
      });
      await bumpLeaderboard(referrerId, POINTS_FOR_COMPLETION, refUser.username || null);
    }

    return res.json({ ok:true });
  } catch (err) {
    logger.error('callback error: ' + err.stack);
    return res.status(500).json({ ok:false, error: err.message });
  }
});

// raw body saver for HMAC
function rawSaver(req, res, buf) {
  req.rawBody = buf;
}

// health + public leaderboard API
app.get('/', (req, res) => res.json({ ok:true, service:'telebot-referral' }));
app.get('/leaderboard/top/:n', async (req, res) => {
  const n = Math.min(100, Math.max(1, parseInt(req.params.n || '50', 10)));
  const snap = await db.ref('leaderboard').orderByChild('points').limitToLast(n).once('value');
  const obj = snap.val() || {};
  const arr = Object.keys(obj).map(k => ({ userId: k, ...obj[k] })).sort((a,b) => (b.points||0) - (a.points||0));
  res.json({ ok:true, top: arr });
});

app.listen(PORT, async () => {
  logger.info(`server listening on ${PORT}`);
  try {
    await ensureBotUsername();
    logger.info(`bot username = @${BOT_USERNAME}`);
  } catch (e) {
    logger.warn('getMe failed (webhook likely not set yet): ' + e.message);
  }
});
