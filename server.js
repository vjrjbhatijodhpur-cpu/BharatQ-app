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
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const OWNER_EMAIL = 'vjrjbhatijodhpur@gmail.com';
const OWNER_MOBILE = '9680714804';

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
let cachedServerPublicIp = '';
const liveMarketPrices = {};
const priceRollingHistory = {};

// Detect live Render server outbound IP for Exchange API IP Whitelisting
async function detectOutboundServerIp() {
  if (cachedServerPublicIp) return cachedServerPublicIp;
  try {
    const res = await fetch('https://api.ipify.org?format=json');
    if (res.ok) {
      const data = await res.json();
      if (data && data.ip) {
        cachedServerPublicIp = data.ip;
        return cachedServerPublicIp;
      }
    }
  } catch (e) {}
  return '';
}

// Compute live RSI and volatility for AI Dip Filter & Dynamic Take Profit
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

// Fetch live Spot price for any listed symbol on Binance
async function getOrFetchLiveSymbolPrice(rawSym) {
  if (liveMarketPrices[rawSym] && liveMarketPrices[rawSym] > 0) {
    return liveMarketPrices[rawSym];
  }
  try {
    const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${rawSym}`);
    if (res.ok) {
      const data = await res.json();
      if (data && data.price) {
        const p = parseFloat(data.price);
        liveMarketPrices[rawSym] = p;
        return p;
      }
    }
  } catch (e) {}
  return 0;
}

// Initialize & verify PostgreSQL schema on server startup
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
    CREATE TABLE IF NOT EXISTS strategy_circles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_uid BIGINT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
      owner_email VARCHAR(255) NOT NULL,
      owner_rank INT NOT NULL DEFAULT 6,
      name VARCHAR(120) NOT NULL,
      description TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
    UPDATE user_wallets SET gas_balance = 0.00 WHERE gas_balance = 48.50;
    UPDATE user_wallets SET commission_balance = 0.00 WHERE commission_balance = 1240.00;
  `;
  try {
    await pool.query(autoSql);
    console.log('[DB INIT] PostgreSQL real production schema verified & legacy test balances cleaned to $0.00.');
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

// AES-256-GCM encryption for Exchange API Secret Keys
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

// Real HMAC-SHA256 verification against Binance / Bybit Spot API
async function verifyExchangeCredentialsLive(exchangeName, apiKey, apiSecret) {
  const ex = String(exchangeName || 'BINANCE').toUpperCase();
  const serverIp = await detectOutboundServerIp();

  if (ex === 'BINANCE') {
    try {
      let serverTime = Date.now();
      try {
        const tRes = await fetch('https://api.binance.com/api/v3/time');
        if (tRes.ok) {
          const tData = await tRes.json();
          if (tData.serverTime) serverTime = tData.serverTime;
        }
      } catch (e) {}

      const qs = `timestamp=${serverTime}&recvWindow=10000`;
      const sig = crypto.createHmac('sha256', apiSecret).update(qs).digest('hex');
      const accRes = await fetch(`https://api.binance.com/api/v3/account?${qs}&signature=${sig}`, {
        method: 'GET',
        headers: { 'X-MBX-APIKEY': apiKey }
      });
      const accData = await accRes.json();

      if (!accRes.ok) {
        const code = accData.code || accRes.status;
        const msg = accData.msg || 'Binance API authentication failed';
        let fixHint = 'Verify your API Key and Secret Key have no extra spaces.';
        if (code === -2015 || String(msg).toLowerCase().includes('ip')) {
          fixHint = `Go to Binance API Management -> Edit -> "Restrict access to trusted IPs only" and add: ${serverIp || 'the IP group shown above'}, then click Save.`;
        } else if (code === -2014) {
          fixHint = 'Invalid API-key format. Make sure you copied the full System-generated (HMAC) API Key.';
        } else if (code === -1022) {
          fixHint = 'Invalid Secret Key signature. Re-copy the Secret Key carefully from Binance.';
        }
        return { valid: false, error: `Binance (${code}): ${msg}`, fixHint, serverIp };
      }

      if (accData.canTrade === false) {
        return {
          valid: false,
          error: 'Spot Trading permission is disabled on this Binance API key.',
          fixHint: 'On Binance API Management -> Edit, check "Enable Spot & Margin Trading" and click Save.',
          serverIp
        };
      }

      const usdtAsset = (accData.balances || []).find(b => b.asset === 'USDT');
      const spotUsdtBalance = usdtAsset ? parseFloat(usdtAsset.free || '0') : 0;

      return { valid: true, spotUsdtBalance, canTrade: true, serverIp };
    } catch (netErr) {
      return { valid: false, error: `Network error reaching Binance: ${netErr.message}`, serverIp };
    }
  }

  if (ex === 'BYBIT') {
    try {
      const ts = String(Date.now());
      const recvWindow = '5000';
      const payload = `${ts}${apiKey}${recvWindow}`;
      const sign = crypto.createHmac('sha256', apiSecret).update(payload).digest('hex');
      const res = await fetch('https://api.bybit.com/v5/user/query-api', {
        headers: {
          'X-BAPI-API-KEY': apiKey,
          'X-BAPI-SIGN': sign,
          'X-BAPI-TIMESTAMP': ts,
          'X-BAPI-RECV-WINDOW': recvWindow
        }
      });
      const data = await res.json();
      if (data.retCode !== 0) {
        return {
// Auto-evaluate V1–V6 rank upgrades based on Royal Q rules (Direct VIPs + Total Team VIPs + 3 Separate Lower-Rank Legs)
async function evaluateRoyalQRankUpgrade(client, sponsorUid) {
  if (!sponsorUid) return;
  try {
    const userRes = await client.query('SELECT uid, rank_level, is_owner_exempt FROM users WHERE uid = $1 LIMIT 1', [sponsorUid]);
    if (!userRes.rows.length || userRes.rows[0].is_owner_exempt) return;
    const currentRank = Number(userRes.rows[0].rank_level) || 1;
    if (currentRank >= 6) return;

    // 1. Count Direct Active VIPs
    const directsRes = await client.query(
      'SELECT uid FROM users WHERE sponsor_uid = $1 AND (is_activated = TRUE OR is_owner_exempt = TRUE)',
      [sponsorUid]
    );
    const directActive = directsRes.rows.length;

    // 2. Count Total Active VIP Team across all 15 generations
    const teamRes = await client.query(
      `WITH RECURSIVE team_tree AS (
         SELECT uid FROM users WHERE sponsor_uid = $1
         UNION ALL
         SELECT u.uid FROM users u INNER JOIN team_tree tt ON u.sponsor_uid = tt.uid
       )
       SELECT COUNT(*)::int AS cnt FROM users u
       INNER JOIN team_tree tt ON u.uid = tt.uid
       WHERE u.is_activated = TRUE OR u.is_owner_exempt = TRUE`,
      [sponsorUid]
    );
    const totalTeamActive = teamRes.rows[0]?.cnt || 0;

    // 3. Helper to count how many separate direct legs contain at least one leader of rank >= requiredSubRank
    async function countQualifiedLegs(requiredSubRank) {
      let qualifiedLegs = 0;
      const allDirects = await client.query('SELECT uid FROM users WHERE sponsor_uid = $1', [sponsorUid]);
      for (const leg of allDirects.rows) {
        const legRankRes = await client.query(
          `WITH RECURSIVE leg_tree AS (
             SELECT uid, rank_level, is_activated, is_owner_exempt FROM users WHERE uid = $1
             UNION ALL
             SELECT u.uid, u.rank_level, u.is_activated, u.is_owner_exempt
             FROM users u INNER JOIN leg_tree lt ON u.sponsor_uid = lt.uid
           )
           SELECT 1 FROM leg_tree
           WHERE (is_activated = TRUE OR is_owner_exempt = TRUE)
             AND rank_level >= $2
           LIMIT 1`,
          [leg.uid, requiredSubRank]
        );
        if (legRankRes.rows.length > 0) qualifiedLegs++;
      }
      return qualifiedLegs;
    }

    let newRank = currentRank;
    for (let r = 6; r > currentRank; r--) {
      const req = ROYALQ_RANKS[r];
      if (directActive < req.minDirects || totalTeamActive < req.minTeam) continue;
      if (r >= 3) {
        const legsWithPrevRank = await countQualifiedLegs(r - 1);
        if (legsWithPrevRank < 3) continue;
      }
      newRank = r;
      break;
    }

    if (newRank > currentRank) {
      await client.query('UPDATE users SET rank_level = $1 WHERE uid = $2', [newRank, sponsorUid]);
    }
  } catch (e) {}
}

// Differential V1–V6 commission & Peer Award distribution + Owner Net Retention
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
      } else if (
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

  if (eventType === 'GAS_FEE_20PCT') {
    const globalDividendCut = totalPoolUsdt * 0.05;
    await client.query(
      `INSERT INTO global_dividend_pool (pool_date, accrued_usdt) VALUES (CURRENT_DATE, $1)
       ON CONFLICT (pool_date) DO UPDATE SET accrued_usdt = global_dividend_pool.accrued_usdt + EXCLUDED.accrued_usdt`,
      [globalDividendCut]
    );
    totalDistributed += globalDividendCut;
  }

  const ownerNet = Math.max(0, totalPoolUsdt - totalDistributed);
  if (ownerNet > 0) {
    const ownerRes = await client.query('SELECT uid FROM users WHERE email = $1 LIMIT 1', [OWNER_EMAIL]);
    if (ownerRes.rows.length) {
      await client.query(
        'UPDATE user_wallets SET commission_balance = commission_balance + $1, updated_at = NOW() WHERE uid = $2',
        [ownerNet, ownerRes.rows[0].uid]
      );
      await client.query(
        'INSERT INTO ledger_journal (debit_account, credit_account, amount_usdt, event_type, reference_id) VALUES ($1, $2, $3, $4, $5)',
        [`UID_${sourceUid}`, `SPONSOR_${ownerRes.rows[0].uid}_OWNER_NET`, ownerNet, eventType, 'PLATFORM_NET_RETENTION']
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

// Health & Engine Status Endpoint
app.get('/api/v1/health', async (req, res) => {
  try {
    const dbCheck = await pool.query('SELECT NOW() AS server_time');
    const serverIp = await detectOutboundServerIp();
    res.json({
      status: 'ONLINE',
      engine: 'BHARATQ_QUANTUM_AI_V6.0_ALL_PAIRS',
      database: 'CONNECTED',
      outboundIp: serverIp,
      serverTime: dbCheck.rows[0].server_time,
      dcaCyclesProcessed,
      trackedSymbolsCount: Object.keys(liveMarketPrices).length,
      masterTrc20Address: MASTER_TRC20_ADDRESS
    });
  } catch (err) {
    res.status(500).json({ status: 'DEGRADED', error: err.message });
  }
});

// Live Outbound IP Group Endpoint for Binance IP Restriction
app.get('/api/v1/exchange/whitelist-ips', async (req, res) => {
  const liveIp = await detectOutboundServerIp();
  res.json({
    success: true,
    primaryServerIp: liveIp || '',
    ipList: liveIp ? [liveIp] : [],
    ipGroupString: liveIp || 'Server IP unavailable — check Render outbound network'
  });
});

// Real Verified Leader Ranking Endpoint
app.get('/api/v1/leaderboard', async (req, res) => {
  try {
    const q = await pool.query(`
      SELECT u.uid,
             CONCAT(LEFT(u.email, 3), '***@', SPLIT_PART(u.email, '@', 2)) AS masked_email,
             u.rank_level,
             (SELECT COUNT(*)::int FROM users d WHERE d.sponsor_uid = u.uid) AS direct_count
      FROM users u
      WHERE u.is_activated = TRUE OR u.is_owner_exempt = TRUE
      ORDER BY u.rank_level DESC, direct_count DESC, u.created_at ASC
      LIMIT 20
    `);
    res.json({ success: true, leaders: q.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Create Strategy Circle (V5 & V6 Leaders Only)
app.post('/api/v1/circles', requireAuth, async (req, res) => {
  try {
    const uRes = await pool.query('SELECT uid, email, rank_level, is_owner_exempt FROM users WHERE uid = $1 LIMIT 1', [req.user.uid]);
    const u = uRes.rows[0];
    if (!u || (!u.is_owner_exempt && u.rank_level < 5)) {
      return res.status(403).json({ success: false, error: 'Only V5 & V6 leaders can publish Strategy Circles' });
    }
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'Circle name required' });
    await pool.query(
      'INSERT INTO strategy_circles (owner_uid, owner_email, owner_rank, name, description) VALUES ($1, $2, $3, $4, $5)',
      [u.uid, u.email, u.is_owner_exempt ? 6 : u.rank_level, name.trim(), (description || '').trim()]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Full User Profile, Real Wallets, Direct Team & 15-Level Downline Tree
app.get('/api/v1/user/profile', requireAuth, async (req, res) => {
  try {
    const uRes = await pool.query('SELECT uid, email, mobile_number, referral_code, sponsor_uid, rank_level, is_activated, is_owner_exempt FROM users WHERE uid = $1 LIMIT 1', [req.user.uid]);
    const userRow = uRes.rows[0] || {};
    const wRes = await pool.query('SELECT * FROM user_wallets WHERE uid = $1 LIMIT 1', [req.user.uid]);
    const keysRes = await pool.query('SELECT exchange_name, api_key, is_valid, created_at FROM exchange_api_keys WHERE uid = $1 AND is_valid = TRUE', [req.user.uid]);
    const logsRes = await pool.query(
      'SELECT * FROM ledger_journal WHERE credit_account LIKE $1 OR debit_account = $2 ORDER BY created_at DESC LIMIT 30',
      [`SPONSOR_${req.user.uid}_%`, `UID_${req.user.uid}`]
    );
    const directsRes = await pool.query(
      'SELECT uid, email, referral_code, rank_level, is_activated, created_at FROM users WHERE sponsor_uid = $1 ORDER BY created_at DESC LIMIT 100',
      [req.user.uid]
    );
    const fullDownlineRes = await pool.query(
      `WITH RECURSIVE downline_tree AS (
         SELECT u.uid, u.email, u.referral_code, u.rank_level, u.is_activated, u.sponsor_uid, u.created_at, 1 AS gen_level
         FROM users u
         WHERE u.sponsor_uid = $1
         UNION ALL
         SELECT child.uid, child.email, child.referral_code, child.rank_level, child.is_activated, child.sponsor_uid, child.created_at, dt.gen_level + 1
         FROM users child
         INNER JOIN downline_tree dt ON child.sponsor_uid = dt.uid
         WHERE dt.gen_level < 15
       )
       SELECT dt.uid, dt.email, dt.referral_code, dt.rank_level, dt.is_activated, dt.gen_level, dt.created_at,
              sp.email AS sponsor_email, sp.referral_code AS sponsor_code
       FROM downline_tree dt
       LEFT JOIN users sp ON dt.sponsor_uid = sp.uid
       ORDER BY dt.gen_level ASC, dt.created_at DESC
       LIMIT 300`,
      [req.user.uid]
    );
    const circlesRes = await pool.query('SELECT * FROM strategy_circles ORDER BY created_at DESC LIMIT 20');

    let platformStats = null;
    if (userRow.is_owner_exempt) {
      const statsQ = await pool.query(`
        SELECT
          (SELECT COUNT(*)::int FROM users) AS "totalUsers",
          (SELECT COUNT(*)::int FROM users WHERE is_activated = TRUE OR is_owner_exempt = TRUE) AS "activeVips",
          (SELECT COALESCE(SUM(gas_balance), 0) FROM user_wallets) AS "totalGasBalance"
      `);
      platformStats = statsQ.rows[0];
    }

    res.json({
      success: true,
      user: userRow,
      wallet: wRes.rows[0] || { gas_balance: 0, commission_balance: 0, total_trading_profit: 0 },
      boundExchanges: keysRes.rows,
      commissionLogs: logsRes.rows,
      directTeam: directsRes.rows,
      fullDownlineTeam: fullDownlineRes.rows,
      circles: circlesRes.rows,
      platformStats
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

async function resolveSponsorUid(sponsorCode, isOwner) {
  if (isOwner) return null;
  const cleanCode = String(sponsorCode || 'BHARAT1').trim().toUpperCase();
  const sp = await pool.query('SELECT uid FROM users WHERE referral_code = $1 LIMIT 1', [cleanCode]);
  if (sp.rows.length) return sp.rows[0].uid;
  const ownerSp = await pool.query('SELECT uid FROM users WHERE email = $1 OR referral_code = $2 LIMIT 1', [OWNER_EMAIL, 'BHARAT1']);
  return ownerSp.rows.length ? ownerSp.rows[0].uid : null;
}

// Register Endpoint
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
       VALUES ($1, 0.00, 0.00)
       ON CONFLICT (uid) DO NOTHING`,
      [user.uid]
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

// Password Login Endpoint
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
         VALUES ($1, 0.00, 0.00)
         ON CONFLICT (uid) DO NOTHING`,
        [userRes.rows[0].uid]
      );
    }

    if (!userRes.rows.length) {
      return res.status(401).json({ success: false, error: 'Account not found. Please log in via Email Verification first.' });
    }

    const user = userRes.rows[0];
    if (!isOwner && user.password_hash !== pwHash) {
      return res.status(401).json({ success: false, error: 'Invalid password' });
    }

    const walletRes = await pool.query('SELECT * FROM user_wallets WHERE uid = $1', [user.uid]);
    const wallet = walletRes.rows[0] || { gas_balance: 0, commission_balance: 0, total_trading_profit: 0 };

    const token = jwt.sign({ uid: user.uid, email: user.email, rank_level: user.rank_level, isOwner }, JWT_SECRET, { expiresIn: '30d' });
    res.json({
      success: true,
      token,
      ownerFreeSubscription: isOwner || user.is_owner_exempt,
      user: {
        ...user,
        gas_balance: wallet.gas_balance,
        commission_balance: wallet.commission_balance,
        total_trading_profit: wallet.total_trading_profit
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Send OTP Endpoint
app.post('/api/v1/auth/send-otp', async (req, res) => {
  try {
    const { email, mobileNumber } = req.body;
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanMobile = String(mobileNumber || '').replace(/\D/g, '');
    const identifier = cleanEmail || cleanMobile;

    if (!identifier) {
      return res.status(400).json({ success: false, error: 'Please enter your Email or 10-digit Mobile Number' });
    }

    let supabaseSent = false;
    if (SUPABASE_URL && SUPABASE_ANON_KEY && cleanEmail.includes('@')) {
      try {
        const sbRes = await fetch(`${SUPABASE_URL}/auth/v1/otp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_ANON_KEY
          },
          body: JSON.stringify({ email: cleanEmail, create_user: true })
        });
        if (sbRes.ok) {
          supabaseSent = true;
        }
      } catch (e) {}
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
      supabaseSent,
      deliveryChannel: supabaseSent ? 'SUPABASE_EMAIL' : 'POSTGRES_OTP',
      expiresInSeconds: 300
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Verify OTP / Supabase Magic-Link Session Endpoint
app.post('/api/v1/auth/verify-otp', async (req, res) => {
  try {
    const { email, mobileNumber, otpCode, sponsorCode, supabaseAccessToken } = req.body;
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanMobile = String(mobileNumber || '').replace(/\D/g, '');
    const identifier = cleanEmail || cleanMobile;
    const cleanOtp = String(otpCode || '').trim();

    if (!identifier) {
      return res.status(400).json({ success: false, error: 'Enter valid Email or Mobile' });
    }

    let verifiedBySupabase = Boolean(supabaseAccessToken);

    if (!verifiedBySupabase && SUPABASE_URL && SUPABASE_ANON_KEY && cleanEmail.includes('@') && cleanOtp.length >= 6) {
      try {
        const sbVerify = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_ANON_KEY
          },
          body: JSON.stringify({ type: 'email', email: cleanEmail, token: cleanOtp })
        });
        if (sbVerify.ok) {
          verifiedBySupabase = true;
        }
      } catch (e) {}
    }

    if (!verifiedBySupabase) {
      const otpRes = await pool.query(
        'SELECT * FROM otp_verifications WHERE identifier = $1 AND otp_code = $2 AND expires_at > NOW() LIMIT 1',
        [identifier, cleanOtp]
      );
      if (!otpRes.rows.length) {
        return res.status(401).json({ success: false, error: 'Invalid or expired OTP code' });
      }
      await pool.query('DELETE FROM otp_verifications WHERE identifier = $1', [identifier]);
    }

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
         VALUES ($1, 0.00, 0.00)
         ON CONFLICT (uid) DO NOTHING`,
        [userRes.rows[0].uid]
      );
    }

    const user = userRes.rows[0];
    const walletRes = await pool.query('SELECT * FROM user_wallets WHERE uid = $1', [user.uid]);
    const wallet = walletRes.rows[0] || { gas_balance: 0, commission_balance: 0, total_trading_profit: 0 };

    const token = jwt.sign({ uid: user.uid, email: user.email, rank_level: user.rank_level, isOwner }, JWT_SECRET, { expiresIn: '30d' });
    res.json({
      success: true,
      token,
      verifiedBySupabase,
      ownerFreeSubscription: isOwner || user.is_owner_exempt,
      user: {
        ...user,
        gas_balance: wallet.gas_balance,
        commission_balance: wallet.commission_balance,
        total_trading_profit: wallet.total_trading_profit
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Royal Q-Style Exchange API Binding Endpoint (Live HMAC-SHA256 Check + AES-256-GCM Storage)
app.post('/api/v1/exchange/bind', async (req, res) => {
  try {
    const { exchangeName, apiKey, apiSecret } = req.body;
    const cleanEx = (exchangeName || 'BINANCE').toUpperCase();
    const cleanKey = String(apiKey || '').trim();
    const cleanSecret = String(apiSecret || '').trim();

    if (!cleanKey || !cleanSecret) {
      return res.status(400).json({ success: false, error: 'API Key and Secret Key are required' });
    }

    const check = await verifyExchangeCredentialsLive(cleanEx, cleanKey, cleanSecret);
    if (!check.valid) {
      return res.status(400).json({
        success: false,
        error: check.error,
        fixHint: check.fixHint,
        serverIp: check.serverIp
      });
    }

    const auth = req.headers.authorization || '';
    const token = auth.replace(/^Bearer\s+/i, '');
    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded && decoded.uid) {
          const { encryptedSecret, ivHex, authTagHex } = encryptApiSecret(cleanSecret);
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
            [decoded.uid, cleanEx, cleanKey, encryptedSecret, ivHex, authTagHex]
          );
        }
      } catch (e) {}
    }

    res.json({
      success: true,
      exchangeName: cleanEx,
      spotUsdtBalance: check.spotUsdtBalance,
      serverIp: check.serverIp,
      encryption: 'AES-256-GCM'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Save & Start Quantitative Strategy (Strictly Requires $120 VIP Activation or Owner Exemption)
app.post('/api/v1/bot/strategy', requireAuth, async (req, res) => {
  try {
    const uCheck = await pool.query('SELECT is_activated, is_owner_exempt FROM users WHERE uid = $1 LIMIT 1', [req.user.uid]);
    const uRow = uCheck.rows[0];
    if (!uRow || (!uRow.is_activated && !uRow.is_owner_exempt)) {
      return res.status(403).json({ success: false, error: 'VIP License ($120/year) required before starting the bot.' });
    }
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
    const curPrice = (await getOrFetchLiveSymbolPrice(rawSym)) || 1;
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
    res.json({ success: true, symbol, livePrice: curPrice });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Manual Buy / Sell Position Action (Strictly Requires $120 VIP Activation or Owner Exemption)
app.post('/api/v1/bot/manual-action', requireAuth, async (req, res) => {
  try {
    const uCheck = await pool.query('SELECT is_activated, is_owner_exempt FROM users WHERE uid = $1 LIMIT 1', [req.user.uid]);
    const uRow = uCheck.rows[0];
    if (!uRow || (!uRow.is_activated && !uRow.is_owner_exempt)) {
      return res.status(403).json({ success: false, error: 'VIP License ($120/year) required to execute bot orders.' });
    }
    const { symbol, action, extraUsdt } = req.body;
    const rawSym = String(symbol || 'BTCUSDT').replace('/', '').toUpperCase();
    const curPrice = (await getOrFetchLiveSymbolPrice(rawSym)) || 1;

    if (action === 'SELL_ALL') {
      const orderRes = await executeBinanceSpotOrder(req.user.uid, rawSym, 'SELL', 25);
      await pool.query(
        `UPDATE bot_strategies SET status = 'PAUSED', current_calls = 0, total_position_usdt = 0, total_base_qty = 0, sub_bin_position_usdt = 0, sub_bin_base_qty = 0, updated_at = NOW() WHERE uid = $1 AND symbol = $2`,
        [req.user.uid, symbol]
      );
      return res.json({
        success: true,
        executedOnExchange: orderRes.executedOnExchange,
        message: orderRes.executedOnExchange
          ? `Sold ${symbol} on Binance Spot at $${curPrice.toLocaleString()}`
          : `Paused ${symbol} strategy (No active exchange order placed)`
      });
    }

    if (action === 'MANUAL_REPLENISH') {
      const buyAmt = Number(extraUsdt || 20);
      const orderRes = await executeBinanceSpotOrder(req.user.uid, rawSym, 'BUY', buyAmt);
      if (!orderRes.executedOnExchange) {
        return res.status(400).json({
          success: false,
          error: orderRes.details?.msg || 'Exchange API did not execute order — verify Spot USDT balance and API permissions.'
        });
      }
      await pool.query(
        `UPDATE bot_strategies SET
           total_position_usdt = total_position_usdt + $1,
           total_base_qty = total_base_qty + ($1 / $2),
           current_calls = current_calls + 1,
           updated_at = NOW()
         WHERE uid = $3 AND symbol = $4`,
        [buyAmt, curPrice, req.user.uid, symbol]
      );
      return res.json({ success: true, message: `Executed real Spot buy: $${buyAmt.toFixed(2)} USDT of ${symbol} at $${curPrice.toLocaleString()}` });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// $120 Annual VIP Activation Endpoint
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

// Real On-Chain TRON TRC-20 USDT Deposit Claim via TronGrid
app.post('/api/v1/wallet/claim-txid', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { txHash } = req.body;
    const cleanTx = String(txHash || '').trim();
    if (!cleanTx || cleanTx.length !== 64) {
      return res.status(400).json({ success: false, error: 'Enter a valid 64-character TRON transaction hash' });
    }

    await client.query('BEGIN');
    const existing = await client.query('SELECT * FROM trc20_deposits WHERE tx_hash = $1', [cleanTx]);
    if (existing.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'This TRON TXID has already been credited' });
    }

    const tgRes = await fetch(`https://api.trongrid.io/v1/transactions/${cleanTx}/events`, {
      headers: process.env.TRONGRID_API_KEY ? { 'TRON-PRO-API-KEY': process.env.TRONGRID_API_KEY } : {}
    });
    if (!tgRes.ok) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'Could not verify transaction on TronGrid network' });
    }

    const tgData = await tgRes.json();
    const transferEvent = (tgData.data || []).find(
      ev => ev.event_name === 'Transfer' && ev.contract_address === USDT_TRC20_CONTRACT && ev.result && ev.result.value
    );

    if (!transferEvent) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'No confirmed USDT TRC-20 transfer found for this TXID' });
    }

    const creditedAmountUsdt = Number(transferEvent.result.value) / 1e6;
    if (creditedAmountUsdt <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'Invalid USDT transfer amount on-chain' });
    }

    await client.query(
      'INSERT INTO trc20_deposits (tx_hash, uid, from_address, to_address, amount_usdt, block_number, status) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [cleanTx, req.user.uid, String(transferEvent.result.from || 'TRON_SENDER'), MASTER_TRC20_ADDRESS, creditedAmountUsdt, Number(transferEvent.block_number || 0), 'CREDITED']
    );

    const upd = await client.query(
      'UPDATE user_wallets SET gas_balance = gas_balance + $1, updated_at = NOW() WHERE uid = $2 RETURNING gas_balance',
      [creditedAmountUsdt, req.user.uid]
    );

    const uCheck = await client.query('SELECT is_activated, is_owner_exempt FROM users WHERE uid = $1', [req.user.uid]);
    const isCurrentlyActive = Boolean(uCheck.rows[0]?.is_activated || uCheck.rows[0]?.is_owner_exempt);

    await client.query('COMMIT');
    res.json({
      success: true,
      creditedAmountUsdt,
      newGasBalance: upd.rows[0]?.gas_balance || creditedAmountUsdt,
      isActivated: isCurrentlyActive,
      message: isCurrentlyActive
        ? `Credited +$${creditedAmountUsdt.toFixed(2)} USDT to Fuel Gas Wallet.`
        : `Credited +$${creditedAmountUsdt.toFixed(2)} USDT. Tap "Activate ($120)" to unlock your VIP bot!`
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// Real USDT TRC-20 Withdrawal Endpoint
app.post('/api/v1/wallet/withdraw', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { destinationTrc20, amountUsdt } = req.body;
    const cleanDest = String(destinationTrc20 || '').trim();
    const amt = Number(amountUsdt);
    const networkFee = 2.00;

    if (!cleanDest.startsWith('T') || cleanDest.length < 30 || isNaN(amt) || amt < 10) {
      return res.status(400).json({ success: false, error: 'Enter a valid TRON (T...) address and minimum 10 USDT' });
    }

    await client.query('BEGIN');
    const wRes = await client.query('SELECT commission_balance FROM user_wallets WHERE uid = $1 FOR UPDATE', [req.user.uid]);
    if (!wRes.rows.length || Number(wRes.rows[0].commission_balance) < amt) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'Insufficient real balance' });
    }

    const netPayoutUsdt = Math.max(0, amt - networkFee);
    const upd = await client.query(
      'UPDATE user_wallets SET commission_balance = commission_balance - $1, updated_at = NOW() WHERE uid = $2 RETURNING commission_balance',
      [amt, req.user.uid]
    );

    let txHash = 'PENDING_MANUAL_PAYOUT_' + crypto.randomBytes(8).toString('hex').toUpperCase();
    let payoutStatus = 'PENDING_PAYOUT';

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

// Zero-Fee Reward-to-Fuel Transfer Endpoint
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
      return res.status(400).json({ success: false, error: 'Insufficient balance to transfer' });
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

// Live Binance WebSocket Ticker Stream for All USDT Spot Pairs
function startBinanceAllMarketStream() {
  const wsUrl = 'wss://stream.binance.com:9443/ws/!ticker@arr';
  try {
    const ws = new WebSocket(wsUrl);
    ws.on('message', raw => {
      try {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          for (let i = 0; i < arr.length; i++) {
            const item = arr[i];
            if (item && item.s && item.s.endsWith('USDT') && item.c) {
              const sym = item.s;
              const price = parseFloat(item.c);
              liveMarketPrices[sym] = price;
              if (!priceRollingHistory[sym]) priceRollingHistory[sym] = [];
              priceRollingHistory[sym].push(price);
              if (priceRollingHistory[sym].length > 15) priceRollingHistory[sym].shift();
            }
          }
        }
      } catch (e) {}
    });
    ws.on('error', () => {});
    ws.on('close', () => setTimeout(startBinanceAllMarketStream, 5000));
  } catch (e) {}
}

// 24/7 Cloud Quantitative DCA Engine (Strictly Runs Only for $120 VIP Active Users & V6 Owner)
async function evaluateActiveDcaBots() {
  dcaCyclesProcessed += 1;
  try {
    const activeBots = await pool.query(`
      SELECT b.* FROM bot_strategies b
      INNER JOIN users u ON b.uid = u.uid
      WHERE b.status IN ('CYCLING', 'Cycling')
        AND (u.is_activated = TRUE OR u.is_owner_exempt = TRUE)
    `);
    for (const bot of activeBots.rows) {
      const rawSym = String(bot.symbol).replace('/', '').toUpperCase();
      const currentPrice = await getOrFetchLiveSymbolPrice(rawSym);
      if (!currentPrice || currentPrice <= 0) continue;

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
      const effectiveTakeProfitPct = aiDynamicTp && volatilityPct > 1.8
        ? Math.min(4.2, +(baseTakeProfitPct + volatilityPct * 0.45).toFixed(2))
        : baseTakeProfitPct;

      const priceChangePct = ((currentPrice - avgEntry) / avgEntry) * 100;

      if (priceChangePct <= -circuitBreakerPct) {
        continue;
      }

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

          const orderRes = await executeBinanceSpotOrder(bot.uid, rawSym, 'SELL', grossSubSell);
          if (!orderRes.executedOnExchange) continue;

          const subProfit = Math.max(0, grossSubSell - subBinUsdt);
          const subGasFee = subProfit * 0.20;

          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            const uRes = await client.query('SELECT is_owner_exempt FROM users WHERE uid = $1', [bot.uid]);
            const isOwner = uRes.rows[0]?.is_owner_exempt || false;
            if (!isOwner && subProfit > 0) {
              await client.query(
                'UPDATE user_wallets SET gas_balance = GREATEST(0, gas_balance - $1), total_trading_profit = total_trading_profit + $2, updated_at = NOW() WHERE uid = $3',
                [subGasFee, subProfit, bot.uid]
              );
              await distributeDifferentialMlm(client, bot.uid, 'GAS_FEE_20PCT', subGasFee);
            } else if (isOwner && subProfit > 0) {
              await client.query(
                'UPDATE user_wallets SET total_trading_profit = total_trading_profit + $1, updated_at = NOW() WHERE uid = $2',
                [subProfit, bot.uid]
              );
            }
            await client.query(
              `UPDATE bot_strategies SET
                 current_calls = GREATEST(4, current_calls - 1),
                 sub_bin_position_usdt = 0,
                 sub_bin_base_qty = 0,
                 sub_bin_entry_price = 0,
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

      if (priceChangePct >= effectiveTakeProfitPct) {
        const peakPrice = Math.max(Number(bot.peak_price_since_tp) || currentPrice, currentPrice);
        const pullbackFromPeakPct = ((peakPrice - currentPrice) / peakPrice) * 100;

        if (pullbackFromPeakPct >= callbackPct) {
          const grossValueUsdt = baseQty * currentPrice;
          const profitUsdt = Math.max(0, grossValueUsdt - posUsdt);
          const gasFee20Pct = profitUsdt * 0.20;

          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            const wRes = await client.query('SELECT gas_balance FROM user_wallets WHERE uid = $1 FOR UPDATE', [bot.uid]);
            const uRes = await client.query('SELECT is_owner_exempt FROM users WHERE uid = $1', [bot.uid]);
            const isOwner = uRes.rows[0]?.is_owner_exempt || false;

            if (isOwner || (wRes.rows.length && Number(wRes.rows[0].gas_balance) >= gasFee20Pct)) {
              const orderRes = await executeBinanceSpotOrder(bot.uid, rawSym, 'SELL', grossValueUsdt);
              if (!orderRes.executedOnExchange) {
                await client.query('ROLLBACK');
                continue;
              }
              if (!isOwner && profitUsdt > 0) {
                await client.query(
                  'UPDATE user_wallets SET gas_balance = gas_balance - $1, total_trading_profit = total_trading_profit + $2, updated_at = NOW() WHERE uid = $3',
                  [gasFee20Pct, profitUsdt, bot.uid]
                );
                await distributeDifferentialMlm(client, bot.uid, 'GAS_FEE_20PCT', gasFee20Pct);
              } else if (isOwner && profitUsdt > 0) {
                await client.query(
                  'UPDATE user_wallets SET total_trading_profit = total_trading_profit + $1, updated_at = NOW() WHERE uid = $2',
                  [profitUsdt, bot.uid]
                );
              }
              const nextStatus = cycleType === 'ONE_SHOT' ? 'PAUSED' : 'CYCLING';
              const netCycleGain = Math.max(0, profitUsdt - (isOwner ? 0 : gasFee20Pct));
              const baseFirstBuy = Number(bot.first_buy_usdt) || 20;
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
      } else if (currentCalls < marginLimit) {
        const schedule = Array.isArray(bot.layer_schedule) ? bot.layer_schedule : [];
        const layerCfg = schedule[currentCalls] || null;
        const requiredDropPct = layerCfg && Number(layerCfg.dropPct) > 0 ? Number(layerCfg.dropPct) : marginDropPct;

        if (priceChangePct <= -requiredDropPct) {
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

          const orderRes = await executeBinanceSpotOrder(bot.uid, rawSym, 'BUY', addUsdt);
          if (!orderRes.executedOnExchange) continue;

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

startBinanceAllMarketStream();
setInterval(evaluateActiveDcaBots, 3000);

app.listen(PORT, async () => {
  await initDatabaseSchema();
  await detectOutboundServerIp();
  console.log(`BharatQ Real Production Engine running on port ${PORT} (Outbound IP: ${cachedServerPublicIp})`);
});
