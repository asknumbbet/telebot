const admin = require('firebase-admin');

const svcJsonEnv = process.env.SERVICE_ACCOUNT_JSON || null;
let serviceAccount;

if (svcJsonEnv) {
  try {
    serviceAccount = JSON.parse(svcJsonEnv);
  } catch (err) {
    console.error('FATAL: SERVICE_ACCOUNT_JSON is not valid JSON:', err.message);
    process.exit(1);
  }
} else {
  try {
    // local demo fallback only
    serviceAccount = require('./serviceAccount.demo.json');
    console.warn('WARN: using serviceAccount.demo.json (do not use in production).');
  } catch (_) {
    console.error('FATAL: SERVICE_ACCOUNT_JSON not provided. Set it in Railway Variables.');
    process.exit(1);
  }
}

if (!process.env.FIREBASE_DB_URL) {
  console.error('FATAL: FIREBASE_DB_URL is required');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DB_URL
});

const db = admin.database();
module.exports = { admin, db };
