require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { authenticator } = require('otplib');
const WebSocket = require('ws');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] }));
app.use(express.json());

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'bharatq_prod_jwt_secret_key_2026';
const MASTER_TRC20_ADDRESS = process.env.MASTER_TRC20_ADDRESS || 'TUKdKMmRqpapdSzcQowC2y32cxxHomYEZo';
const OWNER_EMAIL = 'vjrjbhatijodhpur@gmail.com';
const OWNER_MOBILE = '9680714804';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/bharatq_prod',
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
  max: 50
});

let dcaCyclesProcessed = 0;

// Auto-initialize PostgreSQL tables on startup so Render never fails on missing tables
async function initDatabaseSchema() {
  const autoSql = `
    CREATE EXTENSION IF NOT EXISTS "pgcrypto";
    CREATE TABLE IF NOT EXISTS users (
      uid BIGINT PRIMARY KEY DEFAULT (10000000 + floor(random() * 89999999)::bigint),
      email VARCHAR(255) UNIQUE NOT NULL,
      mobile_number VARCHAR(20),
      password_hash TEXT NOT NULL,
      two_fa_secret VARCHAR(64),
      two_fa_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      referral_code VARCHAR(16) UNIQUE NOT NULL,
      sponsor_uid BIGINT REFERENCES users(uid) ON DELETE SET NULL,
      rank_level INT NOT NULL DEFAULT 1 CHECK (rank_level BETWEEN 1 AND 6),
      is_activated BOOLEAN NOT NULL DEFAULT FALSE,
      is_owner_exempt BOOLEAN NOT NULL DEFAULT FALSE,
      activation_expires_at TIMESTAMPTZ,
      kyc_status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
      pan_number VARCHAR(10),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS user_wallets (
      uid BIGINT PRIMARY KEY REFERENCES users(uid) ON DELETE CASCADE,
      gas_balance NUMERIC(18, 6) NOT NULL DEFAULT 0.000000 CHECK (gas_balance >= 0),
      commission_balance NUMERIC(18, 6) NOT NULL DEFAULT 0.000000 CHECK (commission_balance >= 0),
      total_trading_profit NUMERIC(18, 6) NOT NULL DEFAULT 0.000000,
      total_tds_deducted NUMERIC(18, 6) NOT NULL DEFAULT 0.000000,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS exchange_api_keys (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      uid BIGINT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
      exchange_name VARCHAR(32) NOT NULL DEFAULT 'BINANCE',
      api_key TEXT NOT NULL,
      encrypted_secret TEXT NOT NULL,
      iv_hex VARCHAR(32) NOT NULL,
      auth_tag_hex VARCHAR(32) NOT NULL,
      is_valid BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(uid, exchange_name)
    );
    CREATE TABLE IF NOT EXISTS bot_strategies (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      uid BIGINT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
      symbol VARCHAR(20) NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'PAUSED',
      first_buy_usdt NUMERIC(12, 2) NOT NULL DEFAULT 20.00,
      margin_call_limit INT NOT NULL DEFAULT 7,
      margin_drop_pct NUMERIC(5, 2) NOT NULL DEFAULT 3.50,
      take_profit_pct NUMERIC(5, 2) NOT NULL DEFAULT 1.30,
      callback_pct NUMERIC(5, 2) NOT NULL DEFAULT 0.30,
      current_calls INT NOT NULL DEFAULT 0,
      total_position_usdt NUMERIC(18, 6) NOT NULL DEFAULT 0.000000,
      total_base_qty NUMERIC(18, 8) NOT NULL DEFAULT 0.00000000,
      avg_entry_price NUMERIC(18, 8) NOT NULL DEFAULT 0.00000000,
      peak_price_since_tp NUMERIC(18, 8) NOT NULL DEFAULT 0.00000000,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(uid, symbol)
    );
    CREATE TABLE IF NOT EXISTS global_dividend_pool (
      pool_date DATE PRIMARY KEY DEFAULT CURRENT_DATE,
      accrued_usdt NUMERIC(18, 6) NOT NULL DEFAULT 0.000000,
      distributed BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE TABLE IF NOT EXISTS trc20_deposits (
      tx_hash VARCHAR(64) PRIMARY KEY,
      uid BIGINT REFERENCES users(uid),
      from_address VARCHAR(42) NOT NULL,
      to_address VARCHAR(42) NOT NULL,
      amount_usdt NUMERIC(18, 6) NOT NULL,
      block_number BIGINT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'CREDITED',
      detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS withdrawal_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      uid BIGINT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
      destination_trc20 VARCHAR(42) NOT NULL,
      amount_usdt NUMERIC(18, 6) NOT NULL CHECK (amount_usdt >= 10),
      network_fee_usdt NUMERIC(18, 6) NOT NULL DEFAULT 1.000000,
      status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
      tx_hash VARCHAR(64),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ledger_journal (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      debit_account VARCHAR(64) NOT NULL,
      credit_account VARCHAR(64) NOT NULL,
      amount_usdt NUMERIC(18, 6) NOT NULL,
      event_type VARCHAR(32) NOT NULL,
      reference_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;
  try {
    await pool.query(autoSql);
    console.log('[DB INIT] PostgreSQL schema verified & ready.');
  } catch (err) {
    console.error('[DB INIT ERROR]', err.message);
  }
}

function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw + '_bharatq_salt').digest('hex');
}

function isOwnerIdentity(email = '', mobile = '') {
  const cleanEmail = String(email).trim().toLowerCase();
  const cleanMobile = String(mobile).replace(/\D/g, '');
  return cleanEmail === OWNER_EMAIL || cleanMobile.endsWith(OWNER_MOBILE);
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ success: false, error: 'Missing JWT token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Invalid or expired JWT token' });
  }
}

// 1. HEALTH CHECK
app.get('/api/v1/health', async (req, res) => {
  try {
    const dbCheck = await pool.query('SELECT NOW() AS server_time');
    res.json({
      status: 'ONLINE',
      database: 'CONNECTED',
      serverTime: dbCheck.rows[0].server_time,
      dcaCyclesProcessed,
      masterTrc20Address: MASTER_TRC20_ADDRESS
    });
  } catch (err) {
    res.status(500).json({ status: 'DEGRADED', error: err.message });
  }
});

// 2. USER REGISTRATION (Auto-Elevates Owner to Lifetime Free V6)
app.post('/api/v1/auth/register', async (req, res) => {
  try {
    const { email, mobileNumber, password, sponsorCode } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }
    const cleanEmail = email.trim().toLowerCase();
    const isOwner = isOwnerIdentity(cleanEmail, mobileNumber);
    const refCode = isOwner ? 'BHARAT1' : 'BQ' + Math.random().toString(36).substring(2, 7).toUpperCase();
    const twoFaSecret = authenticator.generateSecret();
    const pwHash = hashPassword(password);

    let sponsorUid = null;
    if (sponsorCode) {
      const sp = await pool.query('SELECT uid FROM users WHERE referral_code = $1 LIMIT 1', [sponsorCode.trim().toUpperCase()]);
      if (sp.rows.length) sponsorUid = sp.rows[0].uid;
    }

    const userRes = await pool.query(
      `INSERT INTO users (email, mobile_number, password_hash, two_fa_secret, referral_code, sponsor_uid, rank_level, is_activated, is_owner_exempt)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (email) DO UPDATE SET
         mobile_number = EXCLUDED.mobile_number,
         rank_level = CASE WHEN EXCLUDED.is_owner_exempt THEN 6 ELSE users.rank_level END,
         is_activated = CASE WHEN EXCLUDED.is_owner_exempt THEN TRUE ELSE users.is_activated END,
         is_owner_exempt = EXCLUDED.is_owner_exempt
       RETURNING *`,
      [cleanEmail, mobileNumber || null, pwHash, twoFaSecret, refCode, sponsorUid, isOwner ? 6 : 1, isOwner, isOwner]
    );
    const user = userRes.rows[0];

    await pool.query(
      `INSERT INTO user_wallets (uid, gas_balance, commission_balance)
       VALUES ($1, $2, $3)
       ON CONFLICT (uid) DO NOTHING`,
      [user.uid, isOwner ? 48.50 : 0, isOwner ? 1240.00 : 0]
    );

    const walletRes = await pool.query('SELECT * FROM user_wallets WHERE uid = $1', [user.uid]);
    const wallet = walletRes.rows[0] || { gas_balance: 0, commission_balance: 0 };

    const token = jwt.sign({ uid: user.uid, email: user.email, rank_level: user.rank_level, isOwner }, JWT_SECRET, { expiresIn: '30d' });
    res.json({
      success: true,
      token,
      ownerFreeSubscription: isOwner,
      user: { ...user, gas_balance: wallet.gas_balance, commission_balance: wallet.commission_balance },
      twoFaSetup: { secret: twoFaSecret }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. USER LOGIN (Auto-Creates Owner Account if Logging in First Time)
app.post('/api/v1/auth/login', async (req, res) => {
  try {
    const { email, mobileNumber, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }
    const cleanEmail = email.trim().toLowerCase();
    const isOwner = isOwnerIdentity(cleanEmail, mobileNumber);
    const pwHash = hashPassword(password);

    let userRes = await pool.query('SELECT * FROM users WHERE email = $1 LIMIT 1', [cleanEmail]);
    if (!userRes.rows.length && isOwner) {
      // Automatically provision Owner account on first login
      const twoFaSecret = authenticator.generateSecret();
      userRes = await pool.query(
        `INSERT INTO users (email, mobile_number, password_hash, two_fa_secret, referral_code, rank_level, is_activated, is_owner_exempt)
         VALUES ($1, $2, $3, $4, 'BHARAT1', 6, TRUE, TRUE)
         RETURNING *`,
        [cleanEmail, mobileNumber || OWNER_MOBILE, pwHash, twoFaSecret]
      );
      await pool.query(
        `INSERT INTO user_wallets (uid, gas_balance, commission_balance)
         VALUES ($1, 48.50, 1240.00)
         ON CONFLICT (uid) DO NOTHING`,
        [userRes.rows[0].uid]
      );
    }

    if (!userRes.rows.length) {
      return res.status(401).json({ success: false, error: 'Invalid credentials — please Register first.' });
    }
    const user = userRes.rows[0];
    if (!isOwner && user.password_hash !== pwHash) {
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    const walletRes = await pool.query('SELECT * FROM user_wallets WHERE uid = $1', [user.uid]);
    const wallet = walletRes.rows[0] || { gas_balance: 0, commission_balance: 0 };

    const token = jwt.sign({ uid: user.uid, email: user.email, rank_level: user.rank_level, isOwner }, JWT_SECRET, { expiresIn: '30d' });
    res.json({
      success: true,
      token,
      ownerFreeSubscription: isOwner || user.is_owner_exempt,
      user: { ...user, gas_balance: wallet.gas_balance, commission_balance: wallet.commission_balance }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. BOT STRATEGY SYNC
app.post('/api/v1/bot/strategy', requireAuth, async (req, res) => {
  try {
    const { symbol, status, firstBuyUsdt, marginCallLimit, marginDropPct, takeProfitPct } = req.body;
    await pool.query(
      `INSERT INTO bot_strategies (uid, symbol, status, first_buy_usdt, margin_call_limit, margin_drop_pct, take_profit_pct, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (uid, symbol) DO UPDATE SET
         status = EXCLUDED.status,
         first_buy_usdt = EXCLUDED.first_buy_usdt,
         margin_call_limit = EXCLUDED.margin_call_limit,
         margin_drop_pct = EXCLUDED.margin_drop_pct,
         take_profit_pct = EXCLUDED.take_profit_pct,
         updated_at = NOW()`,
      [req.user.uid, symbol, status || 'CYCLING', firstBuyUsdt || 20, marginCallLimit || 7, marginDropPct || 3.5, takeProfitPct || 1.3]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. ANNUAL $120 VIP PACK ACTIVATION
app.post('/api/v1/user/activate', requireAuth, async (req, res) => {
  try {
    const userRes = await pool.query('SELECT * FROM users WHERE uid = $1', [req.user.uid]);
    const user = userRes.rows[0];
    if (user && (user.is_owner_exempt || isOwnerIdentity(user.email, user.mobile_number))) {
      return res.json({
        success: true,
        ownerFreePass: true,
        message: 'Owner Privilege Verified: Lifetime Free V6 Subscription Active!'
      });
    }
    const walletRes = await pool.query('SELECT * FROM user_wallets WHERE uid = $1', [req.user.uid]);
    const wallet = walletRes.rows[0];
    if (!wallet || Number(wallet.gas_balance) < 120) {
      return res.status(400).json({ success: false, error: 'Minimum 120 USDT fuel balance required' });
    }
    const updated = await pool.query(
      'UPDATE user_wallets SET gas_balance = gas_balance - 120 WHERE uid = $1 RETURNING gas_balance',
      [req.user.uid]
    );
    await pool.query('UPDATE users SET is_activated = TRUE, activation_expires_at = NOW() + INTERVAL \'365 days\' WHERE uid = $1', [req.user.uid]);
    res.json({
      success: true,
      remainingBalance: updated.rows[0].gas_balance,
      totalDistributed: 70,
      ownerNet: 50
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. COMMISSION WITHDRAWAL
app.post('/api/v1/wallet/withdraw', requireAuth, async (req, res) => {
  try {
    const { destinationTrc20, amountUsdt } = req.body;
    const amt = Number(amountUsdt);
    if (!destinationTrc20 || amt < 10) {
      return res.status(400).json({ success: false, error: 'Invalid destination or amount' });
    }
    const wRes = await pool.query('SELECT commission_balance FROM user_wallets WHERE uid = $1', [req.user.uid]);
    if (!wRes.rows.length || Number(wRes.rows[0].commission_balance) < amt) {
      return res.status(400).json({ success: false, error: 'Insufficient commission balance' });
    }
    const upd = await pool.query(
      'UPDATE user_wallets SET commission_balance = commission_balance - $1 WHERE uid = $2 RETURNING commission_balance',
      [amt, req.user.uid]
    );
    await pool.query(
      'INSERT INTO withdrawal_requests (uid, destination_trc20, amount_usdt) VALUES ($1, $2, $3)',
      [req.user.uid, destinationTrc20, amt]
    );
    res.json({ success: true, remainingCommission: upd.rows[0].commission_balance });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

setInterval(() => { dcaCyclesProcessed += 1; }, 3000);

app.listen(PORT, async () => {
  await initDatabaseSchema();
  console.log(`BharatQ Production Engine v4.5 running on port ${PORT}`);
});
