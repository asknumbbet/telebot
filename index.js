require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const winston = require('winston');
const helmet = require('helmet');

// --- Config ---
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET_PATH = process.env.WEBHOOK_SECRET_PATH || 'webhook';
const NODE_ENV = process.env.NODE_ENV || 'development';

if (!TOKEN) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN not set in environment.');
  process.exit(1);
}

// --- Logger ---
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level.toUpperCase()}] ${message}`;
    })
  ),
  transports: [new winston.transports.Console()],
});

// --- App + Bot ---
const app = express();
app.use(express.json());
app.use(helmet());

// Create bot in webhook mode
const bot = new TelegramBot(TOKEN);
bot.setWebHook(`${process.env.WEBHOOK_BASE_URL || ''}/${WEBHOOK_SECRET_PATH}`);

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', env: NODE_ENV });
});

// Webhook handler
app.post(`/${WEBHOOK_SECRET_PATH}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Basic /start handler
bot.onText(/\/start/, (msg) => {
  logger.info(`User ${msg.chat.id} started bot`);
  bot.sendMessage(msg.chat.id, 'Welcome! Bot is live.');
});

// Start server
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT} in ${NODE_ENV} mode`);
  logger.info(`Webhook path: /${WEBHOOK_SECRET_PATH}`);
});
