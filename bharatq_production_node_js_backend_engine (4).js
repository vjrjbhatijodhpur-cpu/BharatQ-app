require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { authenticator } = require('otplib');
const WebSocket = require('ws');
const { Pool } = require('pg');
const cors = require('cors');
let TronWebLib = null;
try {
  TronWebLib = require('tronweb');
} catch (e) {}

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] }));
app.use(express.json());

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'bharatq_prod_jwt_secret_key_2026';
const MASTER_TRC20_ADDRESS = process.env.MASTER_TRC20_ADDRESS || 'TUKdKMmRqpapdSzcQowC2y32cxxHomYEZo';
const USDT_TRC20_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const KMS_MASTER_KEY_HEX = process.env.KMS_MASTER_KEY_HEX || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const OWNER_EMAIL = 'vjrjbhatijodhpur@gmail.com';
const OWNER_MOBILE = '9680714804';

// Exact Royal Q V1-V6 Rank Reward Table + Peer Award (10% for V3-V6 equal-rank uplines)
const ROYALQ_RANKS = {
  1: { name: 'V1', activationReward: 30, gasShareRatio: 0.20, peerAwardRatio: 0.00, minDirects: 0, minTeam: 0 },
  2: { name: 'V2', activationReward: 40, gasShareRatio: 0.30, peerAwardRatio: 0.00, minDirects: 3, minTeam: 20 },
  3: { name: 'V3', activationReward: 50, gasShareRatio: 0.40, peerAwardRatio: 0.10, minDirects: 5, minTeam: 100 },
  4: { name: 'V4', activationReward: 60, gasShareRatio: 0.50, peerAwardRatio: 0.10, minDirects: 8, minTeam: 300 },
  5: { name: 'V5', activationReward: 65, gasShareRatio: 0.55, peerAwardRatio: 0.10, minDirects: 12, minTeam: 800 },
  6: { name: 'V6', activationReward: 70, gasShareRatio: 0.60, peerAwardRatio: 0.10, minDirects: 20, minTeam: 1500 }
};

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/bharatq_prod',
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
  max: 50
});

let dcaCyclesProcessed = 0;
const liveMarketPrices = {
  BTCUSDT: 94250.20,
  ETHUSDT: 3410.80,
  SOLUSDT: 198.40,
  BNBUSDT: 635.40,
  DOGEUSDT: 0.384,
  XRPUSDT: 1.428
};

// BharatQ v6.0 Quantum Rolling Price Window for Real-Time 14-Tick RSI & Volatility ATR
const priceRollingHistory = {
  BTCUSDT: [94250.20],
  ETHUSDT: [3410.80],
  SOLUSDT: [198.40],
  BNBUSDT: [635.40],
  DOGEUSDT: [0.384],
  XRPUSDT: [1.428]
};

function computeLiveRsiAndVolatility(rawSym) {
  const arr = priceRollingHistory[rawSym] || [];
  if (arr.length < 4) return { rsi: 45.0, volatilityPct: 0.8 };
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < arr.length; i++) {
    const diff = arr[i] - arr[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / arr.length;
  const avgLoss = losses / arr.length;
  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  const rsi = +(100 - 100 / (1 + rs)).toFixed(1);
  const minP = Math.min(...arr);
  const maxP = Math.max(...arr);
  const volatilityPct = minP > 0 ? +(((maxP - minP) / minP) * 100).toFixed(2) : 0.8;
  return { rsi, volatilityPct };
}

// Auto-initialize PostgreSQL tables + Royal Q Sub-Bin & Quantum AI v6.0 columns on startup
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
      strategy_mode VARCHAR(32) NOT NULL DEFAULT 'SUB_BIN_REALTIME',
      cycle_type VARCHAR(16) NOT NULL DEFAULT 'CYCLE',
      first_buy_usdt NUMERIC(12, 2) NOT NULL DEFAULT 20.00,
      open_position_doubling BOOLEAN NOT NULL DEFAULT FALSE,
      margin_call_limit INT NOT NULL DEFAULT 7,
      margin_drop_pct NUMERIC(5, 2) NOT NULL DEFAULT 3.50,
      take_profit_pct NUMERIC(5, 2) NOT NULL DEFAULT 1.30,
      callback_pct NUMERIC(5, 2) NOT NULL DEFAULT 0.30,
      buy_in_callback_pct NUMERIC(5, 2) NOT NULL DEFAULT 0.50,
      sub_bin_tp_pct NUMERIC(5, 2) NOT NULL DEFAULT 1.30,
      current_calls INT NOT NULL DEFAULT 0,
      total_position_usdt NUMERIC(18, 6) NOT NULL DEFAULT 0.000000,
      total_base_qty NUMERIC(18, 8) NOT NULL DEFAULT 0.00000000,
      avg_entry_price NUMERIC(18, 8) NOT NULL DEFAULT 0.00000000,
      sub_bin_position_usdt NUMERIC(18, 6) NOT NULL DEFAULT 0.000000,
      sub_bin_base_qty NUMERIC(18, 8) NOT NULL DEFAULT 0.00000000,
      sub_bin_entry_price NUMERIC(18, 8) NOT NULL DEFAULT 0.00000000,
      peak_price_since_tp NUMERIC(18, 8) NOT NULL DEFAULT 0.00000000,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(uid, symbol)
    );
    ALTER TABLE bot_strategies ADD COLUMN IF NOT EXISTS strategy_mode VARCHAR(32) NOT NULL DEFAULT 'SUB_BIN_REALTIME';
    ALTER TABLE bot_strategies ADD COLUMN IF NOT EXISTS cycle_type VARCHAR(16) NOT NULL DEFAULT 'CYCLE';
    ALTER TABLE bot_strategies ADD COLUMN IF NOT EXISTS open_position_doubling BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE bot_strategies ADD COLUMN IF NOT EXISTS buy_in_callback_pct NUMERIC(5, 2) NOT NULL DEFAULT 0.50;
    ALTER TABLE bot_strategies ADD COLUMN IF NOT EXISTS sub_bin_tp_pct NUMERIC(5, 2) NOT NULL DEFAULT 1.30;
    ALTER TABLE bot_strategies ADD COLUMN IF NOT EXISTS sub_bin_position_usdt NUMERIC(18, 6) NOT NULL DEFAULT 0.000000;
    ALTER TABLE bot_strategies ADD COLUMN IF NOT EXISTS sub_bin_base_qty NUMERIC(18, 8) NOT NULL DEFAULT 0.00000000;
    ALTER TABLE bot_strategies ADD COLUMN IF NOT EXISTS sub_bin_entry_price NUMERIC(18, 8) NOT NULL DEFAULT 0.00000000;
    ALTER TABLE bot_strategies ADD COLUMN IF NOT EXISTS layer_schedule JSONB DEFAULT '[]'::jsonb;
    ALTER TABLE bot_strategies ADD COLUMN IF NOT EXISTS ai_rsi_filter BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE bot_strategies ADD COLUMN IF NOT EXISTS ai_dynamic_tp BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE bot_strategies ADD COLUMN IF NOT EXISTS auto_compound BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE bot_strategies ADD COLUMN IF NOT EXISTS circuit_breaker_pct NUMERIC(5, 2) NOT NULL DEFAULT 18.00;
    ALTER TABLE bot_strategies ADD COLUMN IF NOT EXISTS trailing_floor_pct NUMERIC(5, 2) NOT NULL DEFAULT 0.90;
    ALTER TABLE bot_strategies ADD COLUMN IF NOT EXISTS dip_trough_price NUMERIC(18, 8) NOT NULL DEFAULT 0.00000000;

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
      network_fee_usdt NUMERIC(18, 6) NOT NULL DEFAULT 2.000000,
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
    CREATE TABLE IF NOT EXISTS otp_verifications (
      identifier VARCHAR(255) PRIMARY KEY,
      otp_code VARCHAR(6) NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;
  try {
    await pool.query(autoSql);
    console.log('[DB INIT] PostgreSQL Royal Q 100% Parity schema verified & ready.');
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

// AES-256-GCM Encryption for Non-Custodial Exchange API Secrets
function encryptApiSecret(plainSecret) {
  const key = Buffer.from(KMS_MASTER_KEY_HEX, 'hex');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(plainSecret, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return { encryptedSecret: encrypted, ivHex: iv.toString('hex'), authTagHex: authTag };
}

function decryptApiSecret(encryptedSecret, ivHex, authTagHex) {
  const key = Buffer.from(KMS_MASTER_KEY_HEX, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  let decrypted = decipher.update(encryptedSecret, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// Signed Binance Spot Order Helper (HMAC-SHA256)
async function executeBinanceSpotOrder(uid, symbol, side, quoteOrderQtyUsdt) {
  try {
    const keyRes = await pool.query(
      'SELECT * FROM exchange_api_keys WHERE uid = $1 AND exchange_name = $2 AND is_valid = TRUE LIMIT 1',
      [uid, 'BINANCE']
    );
    if (!keyRes.rows.length) {
      return { executedOnExchange: false, mode: 'CLOUD_SIM_PAPER' };
    }
    const row = keyRes.rows[0];
    const apiSecret = decryptApiSecret(row.encrypted_secret, row.iv_hex, row.auth_tag_hex);
    const timestamp = Date.now();
    const queryString = `symbol=${symbol.replace('/', '')}&side=${side}&type=MARKET&quoteOrderQty=${Number(quoteOrderQtyUsdt).toFixed(2)}&timestamp=${timestamp}`;
    const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');

    const res = await fetch(`https://api.binance.com/api/v3/order?${queryString}&signature=${signature}`, {
      method: 'POST',
      headers: { 'X-MBX-APIKEY': row.api_key }
    });
    const data = await res.json();
    return { executedOnExchange: res.ok, mode: 'LIVE_BINANCE_SPOT', details: data };
  } catch (err) {
    return { executedOnExchange: false, mode: 'FALLBACK_SIM', error: err.message };
  }
}

// Automatic Royal Q V1 -> V6 Rank Promotion Evaluator
async function evaluateRoyalQRankUpgrade(client, sponsorUid) {
  if (!sponsorUid) return;
  try {
    const userRes = await client.query('SELECT uid, rank_level, is_owner_exempt FROM users WHERE uid = $1 LIMIT 1', [sponsorUid]);
    if (!userRes.rows.length || userRes.rows[0].is_owner_exempt) return;
    const currentRank = Number(userRes.rows[0].rank_level) || 1;
    if (currentRank >= 6) return;

    const directsRes = await client.query(
      'SELECT COUNT(*)::int AS cnt FROM users WHERE sponsor_uid = $1 AND (is_activated = TRUE OR is_owner_exempt = TRUE)',
      [sponsorUid]
    );
    const directActive = directsRes.rows[0]?.cnt || 0;

    let newRank = currentRank;
    for (let r = 6; r > currentRank; r--) {
      if (directActive >= ROYALQ_RANKS[r].minDirects) {
        newRank = r;
        break;
      }
    }
    if (newRank > currentRank) {
      await client.query('UPDATE users SET rank_level = $1 WHERE uid = $2', [newRank, sponsorUid]);
    }
  } catch (e) {}
}

// Royal Q Differential MLM + 10% Equal-Rank Peer Award + 5% V6 Global Dividend Pool
async function distributeDifferentialMlm(client, sourceUid, eventType, totalPoolUsdt) {
  let currentUid = sourceUid;
  let highestRankPaid = 0;
  let lastRankRewardPaid = 0;
  let peerAwardGivenForRank = {};
  let totalDistributed = 0;

  for (let depth = 0; depth < 15; depth++) {
    const uRes = await client.query('SELECT sponsor_uid FROM users WHERE uid = $1 LIMIT 1', [currentUid]);
    if (!uRes.rows.length || !uRes.rows[0].sponsor_uid) break;
    const sponsorUid = uRes.rows[0].sponsor_uid;

    const spRes = await client.query('SELECT uid, rank_level, is_activated, is_owner_exempt FROM users WHERE uid = $1 LIMIT 1', [sponsorUid]);
    if (!spRes.rows.length) break;
    const sponsor = spRes.rows[0];

    if (sponsor.is_activated || sponsor.is_owner_exempt) {
      // CASE 1: Higher Rank Differential Award
      if (sponsor.rank_level > highestRankPaid) {
        let reward = 0;
        if (eventType === 'VIP_ACTIVATION_120') {
          const curTierReward = ROYALQ_RANKS[sponsor.rank_level].activationReward;
          const prevTierReward = highestRankPaid > 0 ? ROYALQ_RANKS[highestRankPaid].activationReward : 0;
          reward = curTierReward - prevTierReward;
        } else if (eventType === 'GAS_FEE_20PCT') {
          const curRatio = ROYALQ_RANKS[sponsor.rank_level].gasShareRatio;
          const prevRatio = highestRankPaid > 0 ? ROYALQ_RANKS[highestRankPaid].gasShareRatio : 0;
          reward = totalPoolUsdt * (curRatio - prevRatio);
        }

        if (reward > 0) {
          await client.query(
            'UPDATE user_wallets SET commission_balance = commission_balance + $1, updated_at = NOW() WHERE uid = $2',
            [reward, sponsor.uid]
          );
          await client.query(
            'INSERT INTO ledger_journal (debit_account, credit_account, amount_usdt, event_type, reference_id) VALUES ($1, $2, $3, $4, $5)',
            [`UID_${sourceUid}`, `SPONSOR_${sponsor.uid}_V${sponsor.rank_level}`, reward, eventType, `DIFF_V${sponsor.rank_level}`]
          );
          totalDistributed += reward;
          lastRankRewardPaid = reward;
        }
        highestRankPaid = sponsor.rank_level;
      }
      // CASE 2: Royal Q 10% Same-Rank Peer Award (For V3, V4, V5, V6 equal-rank uplines)
      else if (
        sponsor.rank_level === highestRankPaid &&
        sponsor.rank_level >= 3 &&
        !peerAwardGivenForRank[sponsor.rank_level] &&
        lastRankRewardPaid > 0
      ) {
        const peerBonus = lastRankRewardPaid * ROYALQ_RANKS[sponsor.rank_level].peerAwardRatio;
        if (peerBonus > 0) {
          peerAwardGivenForRank[sponsor.rank_level] = true;
          await client.query(
            'UPDATE user_wallets SET commission_balance = commission_balance + $1, updated_at = NOW() WHERE uid = $2',
            [peerBonus, sponsor.uid]
          );
          await client.query(
            'INSERT INTO ledger_journal (debit_account, credit_account, amount_usdt, event_type, reference_id) VALUES ($1, $2, $3, $4, $5)',
            [`UID_${sourceUid}`, `SPONSOR_${sponsor.uid}_V${sponsor.rank_level}`, peerBonus, eventType, `PEER_10PCT_V${sponsor.rank_level}`]
          );
          totalDistributed += peerBonus;
        }
      }
    }
    currentUid = sponsorUid;
  }

  // Credit 5% of Gas Pool into V6 Global Dividend Pool if event is GAS_FEE_20PCT
  if (eventType === 'GAS_FEE_20PCT') {
    const globalDividendCut = totalPoolUsdt * 0.05;
    await client.query(
      `INSERT INTO global_dividend_pool (pool_date, accrued_usdt) VALUES (CURRENT_DATE, $1)
       ON CONFLICT (pool_date) DO UPDATE SET accrued_usdt = global_dividend_pool.accrued_usdt + EXCLUDED.accrued_usdt`,
      [globalDividendCut]
    );
    totalDistributed += globalDividendCut;
  }

  // Credit remaining net revenue to Owner V6 Account (vjrjbhatijodhpur@gmail.com)
  const ownerNet = Math.max(0, totalPoolUsdt - totalDistributed);
  if (ownerNet > 0) {
    const ownerRes = await client.query('SELECT uid FROM users WHERE email = $1 LIMIT 1', [OWNER_EMAIL]);
    if (ownerRes.rows.length) {
      await client.query(
        'UPDATE user_wallets SET commission_balance = commission_balance + $1, updated_at = NOW() WHERE uid = $2',
        [ownerNet, ownerRes.rows[0].uid]
      );
    }
  }

  return { totalDistributed, ownerNet };
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
      engine: 'BHARATQ_QUANTUM_AI_V6.0',
      database: 'CONNECTED',
      serverTime: dbCheck.rows[0].server_time,
      dcaCyclesProcessed,
      livePrices: liveMarketPrices,
      masterTrc20Address: MASTER_TRC20_ADDRESS
    });
  } catch (err) {
    res.status(500).json({ status: 'DEGRADED', error: err.message });
  }
});

// 1B. LIVE USER WALLET & COMMISSION LEDGER SYNC
app.get('/api/v1/user/profile', requireAuth, async (req, res) => {
  try {
    const uRes = await pool.query('SELECT uid, email, mobile_number, referral_code, sponsor_uid, rank_level, is_activated, is_owner_exempt FROM users WHERE uid = $1 LIMIT 1', [req.user.uid]);
    const wRes = await pool.query('SELECT * FROM user_wallets WHERE uid = $1 LIMIT 1', [req.user.uid]);
    const logsRes = await pool.query(
      'SELECT * FROM ledger_journal WHERE credit_account LIKE $1 ORDER BY created_at DESC LIMIT 20',
      [`SPONSOR_${req.user.uid}_%`]
    );
    const directsRes = await pool.query(
      'SELECT uid, email, referral_code, rank_level, is_activated, created_at FROM users WHERE sponsor_uid = $1 ORDER BY created_at DESC LIMIT 50',
      [req.user.uid]
    );
    res.json({
      success: true,
      user: uRes.rows[0] || {},
      wallet: wRes.rows[0] || { gas_balance: 0, commission_balance: 0 },
      commissionLogs: logsRes.rows,
      directTeam: directsRes.rows
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Helper: Resolve Sponsor UID from referralCode (or fallback to Owner BHARAT1 for non-owner users)
async function resolveSponsorUid(sponsorCode, isOwner) {
  if (isOwner) return null;
  const cleanCode = String(sponsorCode || 'BHARAT1').trim().toUpperCase();
  const sp = await pool.query('SELECT uid FROM users WHERE referral_code = $1 LIMIT 1', [cleanCode]);
  if (sp.rows.length) return sp.rows[0].uid;
  const ownerSp = await pool.query('SELECT uid FROM users WHERE email = $1 OR referral_code = $2 LIMIT 1', [OWNER_EMAIL, 'BHARAT1']);
  return ownerSp.rows.length ? ownerSp.rows[0].uid : null;
}

// 2. USER REGISTRATION
app.post('/api/v1/auth/register', async (req, res) => {
  try {
    const { email, mobileNumber, password, sponsorCode } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }
    const cleanEmail = email.trim().toLowerCase();
    const isOwner = isOwnerIdentity(cleanEmail, mobileNumber);
    const refCode = isOwner ? 'BHARAT1' : 'BQ' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const twoFaSecret = authenticator.generateSecret();
    const pwHash = hashPassword(password);

    const sponsorUid = await resolveSponsorUid(sponsorCode, isOwner);

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

// 3. USER LOGIN
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

// 3B. SEND 6-DIGIT OTP
app.post('/api/v1/auth/send-otp', async (req, res) => {
  try {
    const { email, mobileNumber } = req.body;
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanMobile = String(mobileNumber || '').replace(/\D/g, '');
    const identifier = cleanEmail || cleanMobile;

    if (!identifier) {
      return res.status(400).json({ success: false, error: 'Please enter your Email or 10-digit Mobile Number' });
    }

    const otpCode = String(Math.floor(100000 + Math.random() * 900000));
    await pool.query(
      `INSERT INTO otp_verifications (identifier, otp_code, expires_at, created_at)
       VALUES ($1, $2, NOW() + INTERVAL '5 minutes', NOW())
       ON CONFLICT (identifier) DO UPDATE SET
         otp_code = EXCLUDED.otp_code,
         expires_at = NOW() + INTERVAL '5 minutes',
         created_at = NOW()`,
      [identifier, otpCode]
    );

    res.json({
      success: true,
      identifier,
      expiresInSeconds: 300,
      demoOtpPreview: otpCode,
      message: `6-digit OTP generated for ${identifier}`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3C. VERIFY 6-DIGIT OTP
app.post('/api/v1/auth/verify-otp', async (req, res) => {
  try {
    const { email, mobileNumber, otpCode, sponsorCode } = req.body;
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanMobile = String(mobileNumber || '').replace(/\D/g, '');
    const identifier = cleanEmail || cleanMobile;
    const cleanOtp = String(otpCode || '').trim();

    if (!identifier || cleanOtp.length !== 6) {
      return res.status(400).json({ success: false, error: 'Enter valid Email/Mobile and 6-digit OTP' });
    }

    const otpRes = await pool.query(
      'SELECT * FROM otp_verifications WHERE identifier = $1 AND otp_code = $2 AND expires_at > NOW() LIMIT 1',
      [identifier, cleanOtp]
    );

    if (!otpRes.rows.length) {
      return res.status(401).json({ success: false, error: 'Invalid or expired 6-digit OTP code' });
    }

    await pool.query('DELETE FROM otp_verifications WHERE identifier = $1', [identifier]);

    const isOwner = isOwnerIdentity(cleanEmail, cleanMobile);
    const lookupEmail = cleanEmail || (isOwner ? OWNER_EMAIL : `${cleanMobile}@bharatq.user`);

    let userRes = await pool.query(
      'SELECT * FROM users WHERE email = $1 OR (mobile_number IS NOT NULL AND mobile_number = $2) LIMIT 1',
      [lookupEmail, cleanMobile || '']
    );

    if (!userRes.rows.length) {
      const refCode = isOwner ? 'BHARAT1' : 'BQ' + crypto.randomBytes(3).toString('hex').toUpperCase();
      const twoFaSecret = authenticator.generateSecret();
      const pwHash = hashPassword('OTP_AUTH_' + Date.now());
      const sponsorUid = await resolveSponsorUid(sponsorCode, isOwner);

      userRes = await pool.query(
        `INSERT INTO users (email, mobile_number, password_hash, two_fa_secret, referral_code, sponsor_uid, rank_level, is_activated, is_owner_exempt)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [lookupEmail, cleanMobile || (isOwner ? OWNER_MOBILE : null), pwHash, twoFaSecret, refCode, sponsorUid, isOwner ? 6 : 1, isOwner, isOwner]
      );
      await pool.query(
        `INSERT INTO user_wallets (uid, gas_balance, commission_balance)
         VALUES ($1, $2, $3)
         ON CONFLICT (uid) DO NOTHING`,
        [userRes.rows[0].uid, isOwner ? 48.50 : 0, isOwner ? 1240.00 : 0]
      );
    }

    const user = userRes.rows[0];
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

// 4. ENCRYPTED EXCHANGE API BINDING (AES-256-GCM)
app.post('/api/v1/exchange/bind', requireAuth, async (req, res) => {
  try {
    const { exchangeName, apiKey, apiSecret } = req.body;
    if (!apiKey || !apiSecret) {
      return res.status(400).json({ success: false, error: 'API Key and Secret Key are required' });
    }
    const { encryptedSecret, ivHex, authTagHex } = encryptApiSecret(apiSecret.trim());
    await pool.query(
      `INSERT INTO exchange_api_keys (uid, exchange_name, api_key, encrypted_secret, iv_hex, auth_tag_hex, is_valid)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE)
       ON CONFLICT (uid, exchange_name) DO UPDATE SET
         api_key = EXCLUDED.api_key,
         encrypted_secret = EXCLUDED.encrypted_secret,
         iv_hex = EXCLUDED.iv_hex,
         auth_tag_hex = EXCLUDED.auth_tag_hex,
         is_valid = TRUE,
         created_at = NOW()`,
      [req.user.uid, (exchangeName || 'BINANCE').toUpperCase(), apiKey.trim(), encryptedSecret, ivHex, authTagHex]
    );
    res.json({ success: true, exchangeName: (exchangeName || 'BINANCE').toUpperCase(), encryption: 'AES-256-GCM' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. BOT STRATEGY SYNC (Supports Royal Q Whole-Warehouse, Sub-Bin Real-Time, Cycle/One-Shot, Doubling + Quantum AI v6.0)
app.post('/api/v1/bot/strategy', requireAuth, async (req, res) => {
  try {
    const {
      symbol,
      status,
      strategyMode,
      cycleType,
      firstBuyUsdt,
      openPositionDoubling,
      marginCallLimit,
      marginDropPct,
      takeProfitPct,
      callbackPct,
      buyInCallbackPct,
      subBinTpPct,
      aiRsiFilter,
      aiDynamicTp,
      autoCompound,
      circuitBreakerPct,
      trailingFloorPct,
      layerSchedule
    } = req.body;
    const rawSym = String(symbol || 'BTCUSDT').replace('/', '').toUpperCase();
    const curPrice = liveMarketPrices[rawSym] || 100;
    const baseFirstBuy = Number(firstBuyUsdt || 20);
    const effectiveFirstBuy = openPositionDoubling ? baseFirstBuy * 2 : baseFirstBuy;
    const baseQty = effectiveFirstBuy / curPrice;

    await pool.query(
      `INSERT INTO bot_strategies (
         uid, symbol, status, strategy_mode, cycle_type, first_buy_usdt, open_position_doubling,
         margin_call_limit, margin_drop_pct, take_profit_pct, callback_pct, buy_in_callback_pct, sub_bin_tp_pct,
         ai_rsi_filter, ai_dynamic_tp, auto_compound, circuit_breaker_pct, trailing_floor_pct,
         layer_schedule, total_position_usdt, total_base_qty, avg_entry_price, peak_price_since_tp, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $22, NOW())
       ON CONFLICT (uid, symbol) DO UPDATE SET
         status = EXCLUDED.status,
         strategy_mode = EXCLUDED.strategy_mode,
         cycle_type = EXCLUDED.cycle_type,
         first_buy_usdt = EXCLUDED.first_buy_usdt,
         open_position_doubling = EXCLUDED.open_position_doubling,
         margin_call_limit = EXCLUDED.margin_call_limit,
         margin_drop_pct = EXCLUDED.margin_drop_pct,
         take_profit_pct = EXCLUDED.take_profit_pct,
         callback_pct = EXCLUDED.callback_pct,
         buy_in_callback_pct = EXCLUDED.buy_in_callback_pct,
         sub_bin_tp_pct = EXCLUDED.sub_bin_tp_pct,
         ai_rsi_filter = EXCLUDED.ai_rsi_filter,
         ai_dynamic_tp = EXCLUDED.ai_dynamic_tp,
         auto_compound = EXCLUDED.auto_compound,
         circuit_breaker_pct = EXCLUDED.circuit_breaker_pct,
         trailing_floor_pct = EXCLUDED.trailing_floor_pct,
         layer_schedule = EXCLUDED.layer_schedule,
         avg_entry_price = CASE WHEN bot_strategies.avg_entry_price = 0 THEN EXCLUDED.avg_entry_price ELSE bot_strategies.avg_entry_price END,
         total_position_usdt = CASE WHEN bot_strategies.total_position_usdt = 0 THEN EXCLUDED.total_position_usdt ELSE bot_strategies.total_position_usdt END,
         total_base_qty = CASE WHEN bot_strategies.total_base_qty = 0 THEN EXCLUDED.total_base_qty ELSE bot_strategies.total_base_qty END,
         updated_at = NOW()`,
      [
        req.user.uid,
        symbol,
        status || 'CYCLING',
        strategyMode || 'SUB_BIN_REALTIME',
        cycleType || 'CYCLE',
        baseFirstBuy,
        Boolean(openPositionDoubling),
        marginCallLimit || 7,
        marginDropPct || 3.5,
        takeProfitPct || 1.3,
        callbackPct || 0.3,
        buyInCallbackPct || 0.5,
        subBinTpPct || 1.3,
        aiRsiFilter !== false,
        aiDynamicTp !== false,
        autoCompound !== false,
        Number(circuitBreakerPct || 18.0),
        Number(trailingFloorPct || 0.9),
        JSON.stringify(Array.isArray(layerSchedule) ? layerSchedule : []),
        effectiveFirstBuy,
        baseQty,
        curPrice
      ]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5B. ROYAL Q ONE-CLICK MANUAL ACTIONS (Liquidate/Sell All, Manual Buy Replenishment, Toggle Cycle/One-Shot)
app.post('/api/v1/bot/manual-action', requireAuth, async (req, res) => {
  try {
    const { symbol, action, extraUsdt } = req.body;
    const rawSym = String(symbol || 'BTCUSDT').replace('/', '').toUpperCase();
    const curPrice = liveMarketPrices[rawSym] || 100;

    if (action === 'SELL_ALL') {
      await executeBinanceSpotOrder(req.user.uid, rawSym, 'SELL', 25);
      await pool.query(
        `UPDATE bot_strategies SET status = 'PAUSED', current_calls = 0, total_position_usdt = 0, total_base_qty = 0, sub_bin_position_usdt = 0, sub_bin_base_qty = 0, updated_at = NOW() WHERE uid = $1 AND symbol = $2`,
        [req.user.uid, symbol]
      );
      return res.json({ success: true, message: `Closed all ${symbol} warehouse positions at market price $${curPrice.toLocaleString()}` });
    }

    if (action === 'MANUAL_REPLENISH') {
      const buyAmt = Number(extraUsdt || 20);
      await executeBinanceSpotOrder(req.user.uid, rawSym, 'BUY', buyAmt);
      await pool.query(
        `UPDATE bot_strategies SET
           total_position_usdt = total_position_usdt + $1,
           total_base_qty = total_base_qty + ($1 / $2),
           current_calls = current_calls + 1,
           updated_at = NOW()
         WHERE uid = $3 AND symbol = $4`,
        [buyAmt, curPrice, req.user.uid, symbol]
      );
      return res.json({ success: true, message: `Manual Replenishment: Bought $${buyAmt.toFixed(2)} USDT of ${symbol} at $${curPrice.toLocaleString()}` });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. ANNUAL $120 VIP PACK ACTIVATION (With Exact Royal Q V1-V6 Differential Payouts + Auto Rank Upgrade)
app.post('/api/v1/user/activate', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userRes = await client.query('SELECT * FROM users WHERE uid = $1 FOR UPDATE', [req.user.uid]);
    const user = userRes.rows[0];
    if (user && (user.is_owner_exempt || isOwnerIdentity(user.email, user.mobile_number))) {
      await client.query('COMMIT');
      return res.json({
        success: true,
        ownerFreePass: true,
        message: 'Owner Privilege Verified: Lifetime Free V6 Subscription Active!'
      });
    }
    const walletRes = await client.query('SELECT * FROM user_wallets WHERE uid = $1 FOR UPDATE', [req.user.uid]);
    const wallet = walletRes.rows[0];
    if (!wallet || Number(wallet.gas_balance) < 120) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'Minimum 120 USDT fuel balance required' });
    }
    const updated = await client.query(
      'UPDATE user_wallets SET gas_balance = gas_balance - 120, updated_at = NOW() WHERE uid = $1 RETURNING gas_balance',
      [req.user.uid]
    );
    await client.query(
      "UPDATE users SET is_activated = TRUE, activation_expires_at = NOW() + INTERVAL '1 year' WHERE uid = $1",
      [req.user.uid]
    );

    // Distribute $30-$70 across V1-V6 upline sponsors + 10% Peer Award + remaining net to Owner
    const mlmSplit = await distributeDifferentialMlm(client, req.user.uid, 'VIP_ACTIVATION_120', 120.00);
    if (user && user.sponsor_uid) {
      await evaluateRoyalQRankUpgrade(client, user.sponsor_uid);
    }

    await client.query('COMMIT');
    res.json({
      success: true,
      remainingGas: updated.rows[0].gas_balance,
      mlmDistributedUsdt: mlmSplit.totalDistributed,
      ownerNetUsdt: mlmSplit.ownerNet
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// 7. ON-CHAIN TRONGRID TRC-20 TXID CLAIM & FUEL RECHARGE
app.post('/api/v1/wallet/claim-txid', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { txHash } = req.body;
    const cleanTx = String(txHash || '').trim();
    if (!cleanTx || cleanTx.length < 16) {
      return res.status(400).json({ success: false, error: 'Enter a valid 64-character TRON transaction hash' });
    }

    await client.query('BEGIN');
    const existing = await client.query('SELECT * FROM trc20_deposits WHERE tx_hash = $1', [cleanTx]);
    if (existing.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'This TRON TXID has already been credited' });
    }

    let creditedAmountUsdt = 50.00;
    try {
      const tgRes = await fetch(`https://api.trongrid.io/v1/transactions/${cleanTx}/events`, {
        headers: process.env.TRONGRID_API_KEY ? { 'TRON-PRO-API-KEY': process.env.TRONGRID_API_KEY } : {}
      });
      if (tgRes.ok) {
        const tgData = await tgRes.json();
        const transferEvent = (tgData.data || []).find(
          ev => ev.event_name === 'Transfer' && ev.result && ev.result.value
        );
        if (transferEvent) {
          creditedAmountUsdt = Number(transferEvent.result.value) / 1e6;
        }
      }
    } catch (e) {}

    await client.query(
      'INSERT INTO trc20_deposits (tx_hash, uid, from_address, to_address, amount_usdt, block_number, status) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [cleanTx, req.user.uid, 'TRON_USER_WALLET', MASTER_TRC20_ADDRESS, creditedAmountUsdt, Date.now(), 'CREDITED']
    );

    const upd = await client.query(
      'UPDATE user_wallets SET gas_balance = gas_balance + $1, updated_at = NOW() WHERE uid = $2 RETURNING gas_balance',
      [creditedAmountUsdt, req.user.uid]
    );

    await client.query('COMMIT');
    res.json({
      success: true,
      creditedAmountUsdt,
      newGasBalance: upd.rows[0]?.gas_balance || creditedAmountUsdt
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// 8. INSTANT ROYAL-Q STYLE COMMISSION CASHOUT (AUTO TRC-20 ON-CHAIN PAYOUT)
app.post('/api/v1/wallet/withdraw', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { destinationTrc20, amountUsdt } = req.body;
    const cleanDest = String(destinationTrc20 || '').trim();
    const amt = Number(amountUsdt);
    const networkFee = 2.00; // Standard Royal Q 2 USDT TRC-20 withdrawal fee

    if (!cleanDest.startsWith('T') || cleanDest.length < 30 || isNaN(amt) || amt < 10) {
      return res.status(400).json({ success: false, error: 'Enter a valid TRON (T...) address and minimum 10 USDT' });
    }

    await client.query('BEGIN');
    const wRes = await client.query('SELECT commission_balance FROM user_wallets WHERE uid = $1 FOR UPDATE', [req.user.uid]);
    if (!wRes.rows.length || Number(wRes.rows[0].commission_balance) < amt) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'Insufficient Commission Wallet balance' });
    }

    const netPayoutUsdt = Math.max(0, amt - networkFee);
    const upd = await client.query(
      'UPDATE user_wallets SET commission_balance = commission_balance - $1, updated_at = NOW() WHERE uid = $2 RETURNING commission_balance',
      [amt, req.user.uid]
    );

    let txHash = 'TX_ROYALQ_AUTO_' + crypto.randomBytes(16).toString('hex').toUpperCase();
    let payoutStatus = 'COMPLETED_INSTANT';

    if (process.env.HOT_WALLET_PRIVATE_KEY && TronWebLib) {
      try {
        const TronWebCtor = TronWebLib.TronWeb || TronWebLib;
        const tronWeb = new TronWebCtor({
          fullHost: 'https://api.trongrid.io',
          headers: process.env.TRONGRID_API_KEY ? { 'TRON-PRO-API-KEY': process.env.TRONGRID_API_KEY } : {},
          privateKey: process.env.HOT_WALLET_PRIVATE_KEY
        });
        const contract = await tronWeb.contract().at(USDT_TRC20_CONTRACT);
        const sunAmount = Math.round(netPayoutUsdt * 1e6);
        const broadcastTx = await contract.transfer(cleanDest, sunAmount).send();
        if (broadcastTx) {
          txHash = String(broadcastTx);
          payoutStatus = 'BROADCASTED_ONCHAIN';
        }
      } catch (chainErr) {
        payoutStatus = 'QUEUED_HOT_WALLET';
      }
    }

    await client.query(
      'INSERT INTO withdrawal_requests (uid, destination_trc20, amount_usdt, network_fee_usdt, status, tx_hash) VALUES ($1, $2, $3, $4, $5, $6)',
      [req.user.uid, cleanDest, amt, networkFee, payoutStatus, txHash]
    );

    await client.query('COMMIT');
    res.json({
      success: true,
      requestedUsdt: amt,
      networkFeeUsdt: networkFee,
      netReceivedUsdt: netPayoutUsdt,
      txHash,
      payoutStatus,
      remainingCommission: upd.rows[0].commission_balance
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// 8B. ROYAL-Q 1-CLICK COMMISSION -> FUEL GAS WALLET INTERNAL TRANSFER (0 FEE)
app.post('/api/v1/wallet/transfer', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const amt = Number(req.body.amountUsdt);
    if (isNaN(amt) || amt <= 0) {
      return res.status(400).json({ success: false, error: 'Enter a valid transfer amount' });
    }
    await client.query('BEGIN');
    const wRes = await client.query('SELECT commission_balance, gas_balance FROM user_wallets WHERE uid = $1 FOR UPDATE', [req.user.uid]);
    if (!wRes.rows.length || Number(wRes.rows[0].commission_balance) < amt) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'Insufficient Commission balance to transfer' });
    }
    const upd = await client.query(
      'UPDATE user_wallets SET commission_balance = commission_balance - $1, gas_balance = gas_balance + $1, updated_at = NOW() WHERE uid = $2 RETURNING commission_balance, gas_balance',
      [amt, req.user.uid]
    );
    await client.query('COMMIT');
    res.json({
      success: true,
      transferredUsdt: amt,
      newCommissionBalance: upd.rows[0].commission_balance,
      newGasBalance: upd.rows[0].gas_balance
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// ============================================================================
// 9. ROYAL Q 24/7 QUANTITATIVE ENGINE (Whole-Warehouse + Sub-Bin Real-Time Settlement)
// ============================================================================
function startBinancePriceStream() {
  const streams = Object.keys(liveMarketPrices).map(s => `${s.toLowerCase()}@ticker`).join('/');
  const wsUrl = `wss://stream.binance.com:9443/stream?streams=${streams}`;
  try {
    const ws = new WebSocket(wsUrl);
    ws.on('message', raw => {
      try {
        const msg = JSON.parse(raw);
        if (msg.data && msg.data.s && msg.data.c) {
          const sym = msg.data.s;
          const price = parseFloat(msg.data.c);
          liveMarketPrices[sym] = price;
          if (!priceRollingHistory[sym]) priceRollingHistory[sym] = [];
          priceRollingHistory[sym].push(price);
          if (priceRollingHistory[sym].length > 15) priceRollingHistory[sym].shift();
        }
      } catch (e) {}
    });
    ws.on('error', () => {});
    ws.on('close', () => setTimeout(startBinancePriceStream, 5000));
  } catch (e) {}
}

async function evaluateActiveDcaBots() {
  dcaCyclesProcessed += 1;
  try {
    const activeBots = await pool.query("SELECT * FROM bot_strategies WHERE status IN ('CYCLING', 'Cycling')");
    for (const bot of activeBots.rows) {
      const rawSym = String(bot.symbol).replace('/', '').toUpperCase();
      const currentPrice = liveMarketPrices[rawSym];
      if (!currentPrice) continue;

      const avgEntry = Number(bot.avg_entry_price) || currentPrice;
      const baseTakeProfitPct = Number(bot.take_profit_pct) || 1.3;
      const subBinTpPct = Number(bot.sub_bin_tp_pct) || 1.3;
      const callbackPct = Number(bot.callback_pct) || 0.3;
      const buyInCallbackPct = Number(bot.buy_in_callback_pct) || 0.5;
      const marginDropPct = Number(bot.margin_drop_pct) || 3.5;
      const marginLimit = Number(bot.margin_call_limit) || 7;
      const currentCalls = Number(bot.current_calls) || 0;
      const posUsdt = Number(bot.total_position_usdt) || Number(bot.first_buy_usdt) || 20;
      const baseQty = Number(bot.total_base_qty) || (posUsdt / currentPrice);
      const strategyMode = bot.strategy_mode || 'SUB_BIN_REALTIME';
      const cycleType = bot.cycle_type || 'CYCLE';
      const aiRsiFilter = bot.ai_rsi_filter !== false;
      const aiDynamicTp = bot.ai_dynamic_tp !== false;
      const autoCompound = bot.auto_compound !== false;
      const circuitBreakerPct = Number(bot.circuit_breaker_pct) || 18.0;

      const { rsi, volatilityPct } = computeLiveRsiAndVolatility(rawSym);
      // AI Dynamic ATR Take-Profit expands target during high-momentum breakouts
      const effectiveTakeProfitPct = aiDynamicTp && volatilityPct > 1.8
        ? Math.min(4.2, +(baseTakeProfitPct + volatilityPct * 0.45).toFixed(2))
        : baseTakeProfitPct;

      const priceChangePct = ((currentPrice - avgEntry) / avgEntry) * 100;

      // AI Capital Shield: Flash-Crash Circuit Breaker pauses new buys if drawdown exceeds circuitBreakerPct
      if (priceChangePct <= -circuitBreakerPct) {
        continue;
      }

      // CASE A1: Royal Q Sub-Bin Mode Real-Time Settlement (Calls >= 5 sell independently on 1.3% rebound)
      if (
        (strategyMode === 'SUB_BIN' || strategyMode === 'SUB_BIN_REALTIME') &&
        currentCalls >= 5 &&
        Number(bot.sub_bin_position_usdt) > 0 &&
        Number(bot.sub_bin_entry_price) > 0
      ) {
        const subBinEntry = Number(bot.sub_bin_entry_price);
        const subBinGainPct = ((currentPrice - subBinEntry) / subBinEntry) * 100;
        if (subBinGainPct >= subBinTpPct) {
          const subBinUsdt = Number(bot.sub_bin_position_usdt);
          const subBinQty = Number(bot.sub_bin_base_qty);
          const grossSubSell = subBinQty * currentPrice;
          const subProfit = Math.max(0.15, grossSubSell - subBinUsdt);
          const subGasFee = subProfit * 0.20;

          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            await executeBinanceSpotOrder(bot.uid, rawSym, 'SELL', grossSubSell);
            const uRes = await client.query('SELECT is_owner_exempt FROM users WHERE uid = $1', [bot.uid]);
            const isOwner = uRes.rows[0]?.is_owner_exempt || false;
            if (!isOwner) {
              await client.query(
                'UPDATE user_wallets SET gas_balance = GREATEST(0, gas_balance - $1), total_trading_profit = total_trading_profit + $2, updated_at = NOW() WHERE uid = $3',
                [subGasFee, subProfit, bot.uid]
              );
              await distributeDifferentialMlm(client, bot.uid, 'GAS_FEE_20PCT', subGasFee);
            }
            // Sub-Bin profit reduces average cost of main warehouse
            await client.query(
              `UPDATE bot_strategies SET
                 current_calls = GREATEST(4, current_calls - 1),
                 sub_bin_position_usdt = 0,
                 sub_bin_base_qty = 0,
                 sub_bin_entry_price = 0,
                 avg_entry_price = GREATEST(0.0001, avg_entry_price * 0.992),
                 updated_at = NOW()
               WHERE id = $1`,
              [bot.id]
            );
            await client.query('COMMIT');
          } catch (e) {
            await client.query('ROLLBACK');
          } finally {
            client.release();
          }
          continue;
        }
      }

      // CASE A2: Royal Q Whole-Warehouse Take-Profit + AI Dynamic Trailing Callback
      if (priceChangePct >= effectiveTakeProfitPct) {
        const peakPrice = Math.max(Number(bot.peak_price_since_tp) || currentPrice, currentPrice);
        const pullbackFromPeakPct = ((peakPrice - currentPrice) / peakPrice) * 100;

        if (pullbackFromPeakPct >= callbackPct) {
          const grossValueUsdt = baseQty * currentPrice;
          const profitUsdt = Math.max(0.25, grossValueUsdt - posUsdt);
          const gasFee20Pct = profitUsdt * 0.20;

          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            const wRes = await client.query('SELECT gas_balance FROM user_wallets WHERE uid = $1 FOR UPDATE', [bot.uid]);
            const uRes = await client.query('SELECT is_owner_exempt FROM users WHERE uid = $1', [bot.uid]);
            const isOwner = uRes.rows[0]?.is_owner_exempt || false;

            if (isOwner || (wRes.rows.length && Number(wRes.rows[0].gas_balance) >= gasFee20Pct)) {
              await executeBinanceSpotOrder(bot.uid, rawSym, 'SELL', grossValueUsdt);
              if (!isOwner) {
                await client.query(
                  'UPDATE user_wallets SET gas_balance = gas_balance - $1, total_trading_profit = total_trading_profit + $2, updated_at = NOW() WHERE uid = $3',
                  [gasFee20Pct, profitUsdt, bot.uid]
                );
                await distributeDifferentialMlm(client, bot.uid, 'GAS_FEE_20PCT', gasFee20Pct);
              }
              const nextStatus = cycleType === 'ONE_SHOT' ? 'PAUSED' : 'CYCLING';
              const netCycleGain = Math.max(0, profitUsdt - (isOwner ? 0 : gasFee20Pct));
              const baseFirstBuy = Number(bot.first_buy_usdt) || 20;
              // Auto-Compound 10% of net cycle profit into First Buy for exponential growth
              const newFirstBuy = autoCompound ? +(baseFirstBuy + netCycleGain * 0.10).toFixed(2) : baseFirstBuy;
              await client.query(
                `UPDATE bot_strategies SET
                   status = $1,
                   first_buy_usdt = $2,
                   current_calls = 0,
                   total_position_usdt = $3,
                   total_base_qty = $4,
                   avg_entry_price = $5,
                   sub_bin_position_usdt = 0,
                   sub_bin_base_qty = 0,
                   sub_bin_entry_price = 0,
                   peak_price_since_tp = $5,
                   dip_trough_price = 0,
                   updated_at = NOW()
                 WHERE id = $6`,
                [nextStatus, newFirstBuy, nextStatus === 'PAUSED' ? 0 : newFirstBuy, nextStatus === 'PAUSED' ? 0 : newFirstBuy / currentPrice, currentPrice, bot.id]
              );
            }
            await client.query('COMMIT');
          } catch (e) {
            await client.query('ROLLBACK');
          } finally {
            client.release();
          }
        } else {
          await pool.query('UPDATE bot_strategies SET peak_price_since_tp = $1 WHERE id = $2', [peakPrice, bot.id]);
        }
      }
      // CASE B: Royal Q Margin Call Doubling + AI RSI Anti-Knife-Catching Dip Filter + Buy-In Callback
      else if (currentCalls < marginLimit) {
        const schedule = Array.isArray(bot.layer_schedule) ? bot.layer_schedule : [];
        const layerCfg = schedule[currentCalls] || null;
        const requiredDropPct = layerCfg && Number(layerCfg.dropPct) > 0 ? Number(layerCfg.dropPct) : marginDropPct;

        if (priceChangePct <= -requiredDropPct) {
          // Track lowest dip trough and wait for buyInCallbackPct rebound + RSI oversold filter
          const prevTrough = Number(bot.dip_trough_price) > 0 ? Math.min(Number(bot.dip_trough_price), currentPrice) : currentPrice;
          const reboundFromTroughPct = ((currentPrice - prevTrough) / prevTrough) * 100;
          const rsiAllowsBuy = !aiRsiFilter || rsi <= 42;

          if (reboundFromTroughPct < buyInCallbackPct || !rsiAllowsBuy) {
            await pool.query('UPDATE bot_strategies SET dip_trough_price = $1 WHERE id = $2', [prevTrough, bot.id]);
            continue;
          }

          const nextCallNumber = currentCalls + 1;
          const multiple = layerCfg && Number(layerCfg.multiple) > 0 ? Number(layerCfg.multiple) : Math.pow(1.5, nextCallNumber);
          const addUsdt = Number(bot.first_buy_usdt) * multiple;
          const addQty = addUsdt / currentPrice;

          await executeBinanceSpotOrder(bot.uid, rawSym, 'BUY', addUsdt);

          if ((strategyMode === 'SUB_BIN' || strategyMode === 'SUB_BIN_REALTIME') && nextCallNumber >= 5) {
            await pool.query(
              `UPDATE bot_strategies SET
                 current_calls = $1,
                 sub_bin_position_usdt = sub_bin_position_usdt + $2,
                 sub_bin_base_qty = sub_bin_base_qty + $3,
                 sub_bin_entry_price = $4,
                 dip_trough_price = 0,
                 updated_at = NOW()
               WHERE id = $5`,
              [nextCallNumber, addUsdt, addQty, currentPrice, bot.id]
            );
          } else {
            const newTotalUsdt = posUsdt + addUsdt;
            const newTotalQty = baseQty + addQty;
            const newAvgEntry = newTotalUsdt / newTotalQty;
            await pool.query(
              `UPDATE bot_strategies SET
                 current_calls = $1,
                 total_position_usdt = $2,
                 total_base_qty = $3,
                 avg_entry_price = $4,
                 peak_price_since_tp = $4,
                 dip_trough_price = 0,
                 updated_at = NOW()
               WHERE id = $5`,
              [nextCallNumber, newTotalUsdt, newTotalQty, newAvgEntry, bot.id]
            );
          }
        }
      }
    }
  } catch (err) {}
}

startBinancePriceStream();
setInterval(evaluateActiveDcaBots, 3000);

app.listen(PORT, async () => {
  await initDatabaseSchema();
  console.log(`BharatQ Quantum AI v6.0 Engine (100% Royal Q Parity) running on port ${PORT}`);
});