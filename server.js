const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const TronWebPkg = require('tronweb');
const TronWeb = TronWebPkg.TronWeb || TronWebPkg.default || TronWebPkg;

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// =========================================================================================
// 1. PRODUCTION ENVIRONMENT & DATABASE CONFIGURATION
// =========================================================================================
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'bharatq_prod_jwt_secret_change_in_render';
const KMS_MASTER_KEY = Buffer.from(
  (process.env.KMS_MASTER_KEY_HEX || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef').slice(0, 64),
  'hex'
);

const OWNER_EMAIL = 'vjrjbhatijodhpur@gmail.com';
const OWNER_MOBILE_TAIL = '9680714804';
const OWNER_REFERRAL_CODE = 'BHARAT1';
const MASTER_TRON_WALLET = process.env.MASTER_TRC20_ADDRESS || 'TUKdKMmRqpapdSzcQowC2y32cxxHomYEZo';
const USDT_TRC20_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const TRONGRID_API_KEY = process.env.TRONGRID_API_KEY || '';
const HOT_WALLET_PRIVATE_KEY = process.env.HOT_WALLET_PRIVATE_KEY || '';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false }
    : false
});

function createTronClient(privateKey = null) {
  const opts = {
    fullHost: 'https://api.trongrid.io',
    headers: TRONGRID_API_KEY ? { 'TRON-PRO-API-KEY': TRONGRID_API_KEY } : {}
  };
  if (privateKey) opts.privateKey = privateKey;
  return new TronWeb(opts);
}

// =========================================================================================
// 2. AES-256-GCM ENCRYPTION & DETERMINISTIC USER TRC-20 SUB-WALLET DERIVATION
// =========================================================================================
function encryptApiSecret(plainText) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KMS_MASTER_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptApiSecret(cipherPayload) {
  const [ivHex, tagHex, dataHex] = String(cipherPayload).split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', KMS_MASTER_KEY, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}

function deriveUserTronPrivateKeyHex(userId) {
  return crypto
    .createHmac('sha256', KMS_MASTER_KEY)
    .update(`bharatq_trc20_subwallet_v1:${userId}`)
    .digest('hex');
}

async function getOrCreateUserTrc20DepositWallet(userId) {
  const existing = await pool.query(
    'SELECT tron_address, encrypted_pk FROM user_deposit_wallets WHERE user_id = $1 LIMIT 1',
    [userId]
  );
  if (existing.rows.length > 0 && existing.rows[0].tron_address) {
    return existing.rows[0].tron_address;
  }

  const pkHex = deriveUserTronPrivateKeyHex(userId);
  const tronWeb = createTronClient(pkHex);
  const tronAddress = tronWeb.address.fromPrivateKey(pkHex);
  const encryptedPk = encryptApiSecret(pkHex);

  await pool.query(
    `INSERT INTO user_deposit_wallets (user_id, tron_address, encrypted_pk)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId, tronAddress, encryptedPk]
  );
  return tronAddress;
}

function isPlatformOwner(email, mobileNumber = '') {
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanDigits = String(mobileNumber || '').replace(/\D/g, '');
  return cleanEmail === OWNER_EMAIL || (cleanDigits.length >= 10 && cleanDigits.endsWith(OWNER_MOBILE_TAIL));
}

function maskEmailAddress(email) {
  const parts = String(email || '').split('@');
  if (parts.length !== 2) return 'user***@bharatq.io';
  const name = parts[0];
  const visible = name.length <= 2 ? name[0] : name.slice(0, 2);
  return `${visible}***@${parts[1]}`;
}

async function generateUniqueReferralCode() {
  for (let i = 0; i < 12; i++) {
    const code = 'BQ' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const check = await pool.query('SELECT id FROM users WHERE referral_code = $1', [code]);
    if (check.rows.length === 0) return code;
  }
  return 'BQ' + Date.now().toString(36).toUpperCase().slice(-6);
}

// =========================================================================================
// 3. AUTO-MIGRATING POSTGRESQL SCHEMA (100% GENUINE LEDGER & REAL BOT STATE)
// =========================================================================================
async function initDatabaseSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      uid INTEGER UNIQUE,
      email VARCHAR(255) UNIQUE NOT NULL,
      mobile_number VARCHAR(30),
      password_hash VARCHAR(255),
      region VARCHAR(20) DEFAULT 'IN',
      referral_code VARCHAR(32) UNIQUE NOT NULL,
      sponsor_id INTEGER REFERENCES users(id),
      rank_level INTEGER DEFAULT 1,
      is_activated BOOLEAN DEFAULT FALSE,
      is_owner_exempt BOOLEAN DEFAULT FALSE,
      activated_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS wallets (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      gas_balance NUMERIC(18, 6) DEFAULT 0.000000,
      commission_balance NUMERIC(18, 6) DEFAULT 0.000000,
      total_trading_profit NUMERIC(18, 6) DEFAULT 0.000000,
      demo_mode_active BOOLEAN DEFAULT FALSE,
      demo_usdt_balance NUMERIC(18, 6) DEFAULT 0.000000,
      demo_gas_balance NUMERIC(18, 6) DEFAULT 0.000000,
      demo_profit_usdt NUMERIC(18, 6) DEFAULT 0.000000,
      demo_expires_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS user_deposit_wallets (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      tron_address VARCHAR(64) UNIQUE NOT NULL,
      encrypted_pk TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS exchange_credentials (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      exchange_name VARCHAR(32) NOT NULL,
      api_key VARCHAR(255) NOT NULL,
      encrypted_secret TEXT NOT NULL,
      status VARCHAR(20) DEFAULT 'ACTIVE',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, exchange_name)
    );

    CREATE TABLE IF NOT EXISTS ledger_journal (
      id SERIAL PRIMARY KEY,
      event_type VARCHAR(64) NOT NULL,
      reference_id VARCHAR(128),
      debit_account VARCHAR(128) NOT NULL,
      credit_account VARCHAR(128) NOT NULL,
      amount_usdt NUMERIC(18, 6) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS deposit_claims (
      tx_hash VARCHAR(128) PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      tron_address VARCHAR(64),
      amount_usdt NUMERIC(18, 6) NOT NULL,
      swept_to_master BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS withdrawal_requests (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      destination_trc20 VARCHAR(64) NOT NULL,
      gross_amount NUMERIC(18, 6) NOT NULL,
      network_fee NUMERIC(18, 6) NOT NULL,
      net_sent NUMERIC(18, 6) NOT NULL,
      tx_hash VARCHAR(128),
      status VARCHAR(32) DEFAULT 'COMPLETED',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS bot_strategies (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      symbol VARCHAR(32) NOT NULL,
      status VARCHAR(20) DEFAULT 'PAUSED',
      strategy_mode VARCHAR(32) DEFAULT 'SUB_BIN_REALTIME',
      cycle_type VARCHAR(20) DEFAULT 'CYCLE',
      first_buy_usdt NUMERIC(18, 4) DEFAULT 20,
      open_position_doubling BOOLEAN DEFAULT FALSE,
      margin_call_limit INTEGER DEFAULT 7,
      margin_drop_pct NUMERIC(10, 4) DEFAULT 3.5,
      take_profit_pct NUMERIC(10, 4) DEFAULT 1.3,
      callback_pct NUMERIC(10, 4) DEFAULT 0.3,
      buy_in_callback_pct NUMERIC(10, 4) DEFAULT 0.5,
      sub_bin_tp_pct NUMERIC(10, 4) DEFAULT 1.3,
      ai_rsi_filter BOOLEAN DEFAULT TRUE,
      ai_dynamic_tp BOOLEAN DEFAULT TRUE,
      auto_compound BOOLEAN DEFAULT TRUE,
      layer_schedule JSONB DEFAULT '[]'::jsonb,
      current_calls INTEGER DEFAULT 0,
      total_position_usdt NUMERIC(18, 6) DEFAULT 0,
      total_base_qty NUMERIC(24, 8) DEFAULT 0,
      avg_entry_price NUMERIC(24, 8) DEFAULT 0,
      highest_price_since_tp NUMERIC(24, 8) DEFAULT 0,
      lowest_price_since_drop NUMERIC(24, 8) DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, symbol)
    );

    CREATE TABLE IF NOT EXISTS strategy_circles (
      id SERIAL PRIMARY KEY,
      owner_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(100) NOT NULL,
      description VARCHAR(255) DEFAULT '',
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS circle_subscriptions (
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      circle_id INTEGER REFERENCES strategy_circles(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, circle_id)
    );
  `);

  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS uid INTEGER;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS mobile_number VARCHAR(30);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS region VARCHAR(20) DEFAULT 'IN';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_owner_exempt BOOLEAN DEFAULT FALSE;
    ALTER TABLE wallets ADD COLUMN IF NOT EXISTS demo_mode_active BOOLEAN DEFAULT FALSE;
    ALTER TABLE wallets ADD COLUMN IF NOT EXISTS demo_usdt_balance NUMERIC(18, 6) DEFAULT 0.000000;
    ALTER TABLE wallets ADD COLUMN IF NOT EXISTS demo_gas_balance NUMERIC(18, 6) DEFAULT 0.000000;
    ALTER TABLE wallets ADD COLUMN IF NOT EXISTS demo_profit_usdt NUMERIC(18, 6) DEFAULT 0.000000;
    ALTER TABLE wallets ADD COLUMN IF NOT EXISTS demo_expires_at TIMESTAMPTZ;
    ALTER TABLE bot_strategies ADD COLUMN IF NOT EXISTS cycle_type VARCHAR(20) DEFAULT 'CYCLE';
    ALTER TABLE bot_strategies ADD COLUMN IF NOT EXISTS open_position_doubling BOOLEAN DEFAULT FALSE;
    ALTER TABLE bot_strategies ADD COLUMN IF NOT EXISTS callback_pct NUMERIC(10, 4) DEFAULT 0.3;
    ALTER TABLE bot_strategies ADD COLUMN IF NOT EXISTS buy_in_callback_pct NUMERIC(10, 4) DEFAULT 0.5;
    ALTER TABLE bot_strategies ADD COLUMN IF NOT EXISTS sub_bin_tp_pct NUMERIC(10, 4) DEFAULT 1.3;
    ALTER TABLE bot_strategies ADD COLUMN IF NOT EXISTS ai_rsi_filter BOOLEAN DEFAULT TRUE;
    ALTER TABLE bot_strategies ADD COLUMN IF NOT EXISTS ai_dynamic_tp BOOLEAN DEFAULT TRUE;
    ALTER TABLE bot_strategies ADD COLUMN IF NOT EXISTS auto_compound BOOLEAN DEFAULT TRUE;
    ALTER TABLE bot_strategies ADD COLUMN IF NOT EXISTS total_base_qty NUMERIC(24, 8) DEFAULT 0;
    ALTER TABLE bot_strategies ADD COLUMN IF NOT EXISTS avg_entry_price NUMERIC(24, 8) DEFAULT 0;
    ALTER TABLE bot_strategies ADD COLUMN IF NOT EXISTS highest_price_since_tp NUMERIC(24, 8) DEFAULT 0;
    ALTER TABLE bot_strategies ADD COLUMN IF NOT EXISTS lowest_price_since_drop NUMERIC(24, 8) DEFAULT 0;

    UPDATE users SET uid = 100000 + id WHERE uid IS NULL;
  `);

  const ownerRes = await pool.query('SELECT id FROM users WHERE LOWER(email) = $1 LIMIT 1', [OWNER_EMAIL]);
  let ownerId;
  if (ownerRes.rows.length === 0) {
    const ins = await pool.query(
      `INSERT INTO users (email, mobile_number, referral_code, rank_level, is_activated, is_owner_exempt, activated_at)
       VALUES ($1, $2, $3, 6, TRUE, TRUE, NOW()) RETURNING id`,
      [OWNER_EMAIL, '9680714804', OWNER_REFERRAL_CODE]
    );
    ownerId = ins.rows[0].id;
    await pool.query('UPDATE users SET uid = $1 WHERE id = $2', [100000 + ownerId, ownerId]);
    await pool.query('INSERT INTO wallets (user_id, gas_balance, commission_balance) VALUES ($1, 0, 0) ON CONFLICT DO NOTHING', [ownerId]);
  } else {
    ownerId = ownerRes.rows[0].id;
    await pool.query(
      `UPDATE users SET rank_level = 6, is_activated = TRUE, is_owner_exempt = TRUE, referral_code = $1 WHERE id = $2`,
      [OWNER_REFERRAL_CODE, ownerId]
    );
    await pool.query('INSERT INTO wallets (user_id, gas_balance, commission_balance) VALUES ($1, 0, 0) ON CONFLICT DO NOTHING', [ownerId]);
  }
  await getOrCreateUserTrc20DepositWallet(ownerId);
}

// =========================================================================================
// 4. AUTH MIDDLEWARE
// =========================================================================================
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, error: 'Authentication required' });
  try {
    req.auth = jwt.verify(token, JWT_SECRET);
    return next();
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Session expired — please sign in again' });
  }
}

// =========================================================================================
// 5. LIVE BINANCE SIGNED SPOT EXECUTION & REAL BALANCE ENGINE
// =========================================================================================
const BINANCE_CLUSTERS = [
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
  'https://api4.binance.com'
];

let binanceRateLimitCooldownUntilMs = 0;

function formatCooldownTime(ms) {
  try {
    return new Date(ms).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch (e) {
    return new Date(ms).toISOString();
  }
}

async function binanceSignedFetch(path, apiKey, apiSecret, method = 'GET', extraParams = {}) {
  if (Date.now() < binanceRateLimitCooldownUntilMs) {
    return {
      ok: false,
      status: 429,
      rateLimited: true,
      data: { code: -1003, msg: `Binance rate-limit cooldown active until ${formatCooldownTime(binanceRateLimitCooldownUntilMs)}. Using WebSocket streams.` }
    };
  }

  let serverTimestamp = Date.now();
  try {
    const tRes = await fetch('https://api.binance.com/api/v3/time');
    if (tRes.ok) {
      const tData = await tRes.json();
      if (tData && tData.serverTime) serverTimestamp = Number(tData.serverTime);
    }
  } catch (e) {}

  let lastResponse = { ok: false, status: 502, data: { msg: 'Binance API unreachable' } };

  for (const baseUrl of BINANCE_CLUSTERS) {
    try {
      const params = new URLSearchParams({
        ...extraParams,
        timestamp: String(serverTimestamp),
        recvWindow: '10000'
      });
      const qs = params.toString();
      const signature = crypto.createHmac('sha256', apiSecret).update(qs).digest('hex');
      const fullUrl = `${baseUrl}${path}?${qs}&signature=${signature}`;

      const res = await fetch(fullUrl, {
        method,
        headers: { 'X-MBX-APIKEY': apiKey }
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        return { ok: true, status: res.status, data };
      }

      if (res.status === 429 || res.status === 418 || data.code === -1003) {
        const banMatch = String(data.msg || '').match(/banned until (\d{13})/);
        if (banMatch) {
          binanceRateLimitCooldownUntilMs = Math.max(binanceRateLimitCooldownUntilMs, Number(banMatch[1]));
        } else {
          binanceRateLimitCooldownUntilMs = Math.max(binanceRateLimitCooldownUntilMs, Date.now() + 90 * 1000);
        }
        return {
          ok: false,
          status: res.status,
          rateLimited: true,
          data: { code: -1003, msg: `Binance rate-limit cooldown active until ${formatCooldownTime(binanceRateLimitCooldownUntilMs)}. Using WebSocket streams.` }
        };
      }

      lastResponse = { ok: false, status: res.status, data };
      if (data && (data.code === -2015 || data.code === -2014 || data.code === -1022 || data.code === -2010)) {
        break;
      }
    } catch (e) {
      lastResponse = { ok: false, status: 502, data: { msg: e.message } };
    }
  }
  return lastResponse;
}

const symbolRulesCache = new Map();
async function getBinanceSymbolPrecisionRules(rawSymbol) {
  const cached = symbolRulesCache.get(rawSymbol);
  if (cached && Date.now() - cached.fetchedAt < 3600 * 1000) return cached.rules;

  const infoEndpoints = [
    `https://data-api.binance.vision/api/v3/exchangeInfo?symbol=${rawSymbol}`,
    `https://api.binance.com/api/v3/exchangeInfo?symbol=${rawSymbol}`
  ];

  for (const url of infoEndpoints) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      const symInfo = data.symbols && data.symbols[0];
      if (!symInfo) continue;
      const lotFilter = (symInfo.filters || []).find(f => f.filterType === 'LOT_SIZE') || {};
      const minNotionalFilter = (symInfo.filters || []).find(f => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL') || {};
      const rules = {
        stepSize: parseFloat(lotFilter.stepSize || '0.00001'),
        minQty: parseFloat(lotFilter.minQty || '0.00001'),
        minNotional: parseFloat(minNotionalFilter.minNotional || '10')
      };
      symbolRulesCache.set(rawSymbol, { fetchedAt: Date.now(), rules });
      return rules;
    } catch (e) {}
  }
  return { stepSize: 0.00001, minQty: 0.00001, minNotional: 10 };
}

function floorQuantityToStepSize(qty, stepSize) {
  if (!stepSize || stepSize <= 0) return Number(qty.toFixed(6));
  const decimals = Math.max(0, Math.round(-Math.log10(stepSize)));
  const stepped = Math.floor(qty / stepSize) * stepSize;
  return Number(stepped.toFixed(decimals));
}

async function getUserActiveExchangeCreds(userId, preferredExchange = 'BINANCE') {
  const res = await pool.query(
    `SELECT exchange_name, api_key, encrypted_secret
     FROM exchange_credentials
     WHERE user_id = $1 AND status = 'ACTIVE'
     ORDER BY CASE WHEN exchange_name = $2 THEN 0 ELSE 1 END, id DESC
     LIMIT 1`,
    [userId, preferredExchange]
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  return {
    exchangeName: row.exchange_name,
    apiKey: row.api_key,
    apiSecret: decryptApiSecret(row.encrypted_secret)
  };
}

async function getOrFetchLiveSymbolPrice(rawSymbol) {
  const live = liveMarketPriceMap.get(rawSymbol);
  if (live && live.price > 0 && Date.now() - live.updatedAt < 60000) {
    return live.price;
  }
  const priceEndpoints = [
    `https://data-api.binance.vision/api/v3/ticker/price?symbol=${rawSymbol}`,
    `https://api.binance.com/api/v3/ticker/price?symbol=${rawSymbol}`
  ];
  for (const url of priceEndpoints) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const d = await res.json();
      const p = parseFloat(d.price || '0');
      if (p > 0) {
        liveMarketPriceMap.set(rawSymbol, { price: p, changePct: live?.changePct || 0, updatedAt: Date.now() });
        return p;
      }
    } catch (e) {}
  }
  return live?.price || 0;
}

async function executeBinanceSpotOrder({ userId, symbol, side, quoteOrderQtyUsdt = 0, baseQuantity = 0, isDemo = false, fallbackPrice = 0 }) {
  const rawSymbol = symbol.replace('/', '').toUpperCase();

  // 24-HOUR $10,000 PAPER-TRADING SANDBOX EXECUTION (REAL LIVE MARKET PRICES, VIRTUAL BALANCE)
  if (isDemo) {
    const livePrice = Number(fallbackPrice) > 0 ? Number(fallbackPrice) : await getOrFetchLiveSymbolPrice(rawSymbol);
    if (!livePrice || livePrice <= 0) {
      return { success: false, error: `Waiting for live market price tick on ${symbol}...` };
    }
    const wRes = await pool.query('SELECT demo_usdt_balance, demo_gas_balance FROM wallets WHERE user_id = $1', [userId]);
    const demoUsdt = Number(wRes.rows[0]?.demo_usdt_balance || 0);
    const demoGas = Number(wRes.rows[0]?.demo_gas_balance || 0);
    if (demoGas < 1) {
      return { success: false, error: '24H Demo Fuel Gas exhausted — restart 24H $10K Demo to reset.' };
    }
    if (side === 'BUY') {
      const buyUsdt = Number(quoteOrderQtyUsdt);
      if (buyUsdt < 10) return { success: false, error: 'Minimum Spot order size is 10 USDT.' };
      if (demoUsdt < buyUsdt) {
        return { success: false, error: `Insufficient 24H Demo USDT ($${demoUsdt.toFixed(2)} available, $${buyUsdt.toFixed(2)} required).` };
      }
      const filledQty = Number((buyUsdt / livePrice).toFixed(6));
      await pool.query(
        'UPDATE wallets SET demo_usdt_balance = demo_usdt_balance - $1, updated_at = NOW() WHERE user_id = $2',
        [buyUsdt, userId]
      );
      return {
        success: true,
        isDemoOrder: true,
        orderId: `DEMO_${Date.now()}`,
        filledQuoteUsdt: buyUsdt,
        filledBaseQty: filledQty,
        avgFillPrice: livePrice
      };
    } else {
      const sellQty = Number(baseQuantity);
      const receivedUsdt = Number((sellQty * livePrice).toFixed(4));
      await pool.query(
        'UPDATE wallets SET demo_usdt_balance = demo_usdt_balance + $1, updated_at = NOW() WHERE user_id = $2',
        [receivedUsdt, userId]
      );
      return {
        success: true,
        isDemoOrder: true,
        orderId: `DEMO_${Date.now()}`,
        filledQuoteUsdt: receivedUsdt,
        filledBaseQty: sellQty,
        avgFillPrice: livePrice
      };
    }
  }

  // REAL LIVE BINANCE SPOT EXECUTION
  const creds = await getUserActiveExchangeCreds(userId, 'BINANCE');
  if (!creds) {
    return { success: false, error: 'No active Binance API key bound. Bind your Spot API first.' };
  }

  const rules = await getBinanceSymbolPrecisionRules(rawSymbol);

  if (side === 'BUY') {
    const qtyUsdt = Number(quoteOrderQtyUsdt);
    if (qtyUsdt < rules.minNotional) {
      return { success: false, error: `Order amount $${qtyUsdt.toFixed(2)} is below Binance minimum $${rules.minNotional} USDT for ${symbol}.` };
    }
    const res = await binanceSignedFetch('/api/v3/order', creds.apiKey, creds.apiSecret, 'POST', {
      symbol: rawSymbol,
      side: 'BUY',
      type: 'MARKET',
      quoteOrderQty: qtyUsdt.toFixed(2)
    });
    if (!res.ok) {
      const rawMsg = res.data.msg || 'Binance Spot BUY rejected';
      const isGeoRestricted = rawMsg.toLowerCase().includes('restricted location') || res.status === 451;
      if (isGeoRestricted || res.rateLimited) {
        return {
          success: false,
          requiresClientRelay: true,
          relayOrder: {
            side: 'BUY',
            rawSymbol,
            quoteOrderQty: qtyUsdt.toFixed(2),
            apiKey: creds.apiKey,
            apiSecret: creds.apiSecret
          },
          error: isGeoRestricted
            ? 'Binance region restriction detected — executing via Direct Device Relay...'
            : rawMsg
        };
      }
      return { success: false, error: `Binance (${res.data.code || res.status}): ${rawMsg}` };
    }
    const executedQty = parseFloat(res.data.executedQty || '0');
    const spentUsdt = parseFloat(res.data.cummulativeQuoteQty || String(qtyUsdt));
    const avgFillPrice = executedQty > 0 ? spentUsdt / executedQty : 0;
    return {
      success: true,
      orderId: res.data.orderId,
      filledQuoteUsdt: spentUsdt,
      filledBaseQty: executedQty,
      avgFillPrice
    };
  }

  if (side === 'SELL') {
    let sellQty = floorQuantityToStepSize(Number(baseQuantity), rules.stepSize);
    if (sellQty < rules.minQty) {
      const baseAsset = rawSymbol.replace('USDT', '');
      const acctRes = await binanceSignedFetch('/api/v3/account', creds.apiKey, creds.apiSecret, 'GET');
      if (acctRes.ok && Array.isArray(acctRes.data.balances)) {
        const balObj = acctRes.data.balances.find(b => b.asset === baseAsset);
        const freeSpotQty = parseFloat(balObj?.free || '0');
        sellQty = floorQuantityToStepSize(freeSpotQty, rules.stepSize);
      }
    }
    if (sellQty < rules.minQty) {
      return { success: false, error: `Held ${symbol} quantity (${sellQty}) is below Binance minimum lot size (${rules.minQty}).` };
    }
    const res = await binanceSignedFetch('/api/v3/order', creds.apiKey, creds.apiSecret, 'POST', {
      symbol: rawSymbol,
      side: 'SELL',
      type: 'MARKET',
      quantity: String(sellQty)
    });
    if (!res.ok) {
      const rawMsg = res.data.msg || 'Binance Spot SELL rejected';
      const isGeoRestricted = rawMsg.toLowerCase().includes('restricted location') || res.status === 451;
      if (isGeoRestricted || res.rateLimited) {
        return {
          success: false,
          requiresClientRelay: true,
          relayOrder: {
            side: 'SELL',
            rawSymbol,
            quantity: String(sellQty),
            apiKey: creds.apiKey,
            apiSecret: creds.apiSecret
          },
          error: isGeoRestricted
            ? 'Binance region restriction detected — executing via Direct Device Relay...'
            : rawMsg
        };
      }
      return { success: false, error: `Binance (${res.data.code || res.status}): ${rawMsg}` };
    }
    const executedQty = parseFloat(res.data.executedQty || String(sellQty));
    const receivedUsdt = parseFloat(res.data.cummulativeQuoteQty || '0');
    const avgSellPrice = executedQty > 0 ? receivedUsdt / executedQty : 0;
    return {
      success: true,
      orderId: res.data.orderId,
      filledQuoteUsdt: receivedUsdt,
      filledBaseQty: executedQty,
      avgFillPrice: avgSellPrice
    };
  }

  return { success: false, error: 'Unsupported order side' };
}

async function verifyExchangeCredentialsLive(exchangeName, apiKey, apiSecret) {
  const cleanEx = String(exchangeName || 'BINANCE').toUpperCase();
  if (cleanEx === 'BINANCE') {
    const res = await binanceSignedFetch('/api/v3/account', apiKey, apiSecret, 'GET');
    if (res.ok) {
      const usdtAsset = (res.data.balances || []).find(b => b.asset === 'USDT');
      const freeUsdt = parseFloat(usdtAsset ? usdtAsset.free : '0');
      return {
        valid: true,
        canTrade: Boolean(res.data.canTrade),
        spotUsdtBalance: freeUsdt,
        message: `Binance Spot Verified • Available Spot Balance: $${freeUsdt.toFixed(2)} USDT`
      };
    }

    const code = res.data.code;
    const msg = res.data.msg || 'Unable to verify Binance API key';
    let fixHint = 'Verify that your API Key & Secret Key are copied accurately without spaces.';
    if (res.rateLimited || code === -1003) {
      fixHint = 'Binance shared IP cooldown is active — wait ~60 seconds and tap Bind again.';
    } else if (code === -2015) {
      fixHint = 'On Binance API Management: (1) Check "Enable Spot & Margin Trading", and (2) Add the Live Server Outbound IP Group to "Restrict access to trusted IPs only".';
    } else if (code === -1021) {
      fixHint = 'Timestamp sync mismatch — please retry binding now.';
    }
    return { valid: false, error: `Binance (${code || res.status}): ${msg}`, fixHint };
  }

  if (cleanEx === 'BYBIT') {
    try {
      const timestamp = String(Date.now());
      const recvWindow = '5000';
      const payload = `${timestamp}${apiKey}${recvWindow}`;
      const sign = crypto.createHmac('sha256', apiSecret).update(payload).digest('hex');
      const res = await fetch('https://api.bybit.com/v5/user/query-api', {
        headers: {
          'X-BAPI-API-KEY': apiKey,
          'X-BAPI-SIGN': sign,
          'X-BAPI-TIMESTAMP': timestamp,
          'X-BAPI-RECV-WINDOW': recvWindow
        }
      });
      const data = await res.json();
      if (data.retCode === 0) {
        return { valid: true, canTrade: true, spotUsdtBalance: null, message: 'Bybit Unified/Spot API Verified' };
      }
      return {
        valid: false,
        error: `Bybit (${data.retCode}): ${data.retMsg || 'API check failed'}`,
        fixHint: 'Ensure Bybit API key has Spot Trade enabled and whitelists our Server IP Group.'
      };
    } catch (err) {
      return { valid: false, error: 'Unable to reach Bybit API endpoint', fixHint: 'Retry in a few seconds.' };
    }
  }

  return {
    valid: false,
    error: `${cleanEx} Spot connector is not enabled yet.`,
    fixHint: 'Please bind Binance or Bybit for live automated Spot trading.'
  };
}

// =========================================================================================
// 6. REAL ROYAL Q V1–V6 DIFFERENTIAL & PEER COMMISSION ENGINE + AUTOMATIC RANK UPGRADES
// =========================================================================================
const VIP_DIRECT_USD = { 1: 30, 2: 40, 3: 50, 4: 60, 5: 65, 6: 70 };
const GAS_SHARE_PCT = { 1: 0.20, 2: 0.30, 3: 0.40, 4: 0.50, 5: 0.55, 6: 0.60 };

async function evaluateRoyalQRankUpgrade(client, userId) {
  const userRes = await client.query('SELECT id, rank_level, is_activated, is_owner_exempt FROM users WHERE id = $1', [userId]);
  if (userRes.rows.length === 0) return;
  const user = userRes.rows[0];
  if (user.is_owner_exempt || !user.is_activated) return;

  const directRes = await client.query(
    'SELECT id, rank_level FROM users WHERE sponsor_id = $1 AND is_activated = TRUE',
    [userId]
  );
  const directActiveCount = directRes.rows.length;

  const teamRes = await client.query(
    `WITH RECURSIVE downline AS (
       SELECT id, sponsor_id, rank_level, is_activated, 1 AS depth
       FROM users WHERE sponsor_id = $1
       UNION ALL
       SELECT u.id, u.sponsor_id, u.rank_level, u.is_activated, d.depth + 1
       FROM users u
       INNER JOIN downline d ON u.sponsor_id = d.id
       WHERE d.depth < 15
     )
     SELECT COUNT(*)::int AS active_team FROM downline WHERE is_activated = TRUE`,
    [userId]
  );
  const totalTeamActive = Number(teamRes.rows[0]?.active_team || 0);

  let legsWithV2 = 0, legsWithV3 = 0, legsWithV4 = 0, legsWithV5 = 0;
  for (const leg of directRes.rows) {
    const legMaxRes = await client.query(
      `WITH RECURSIVE branch AS (
         SELECT id, rank_level, is_activated, 1 AS depth FROM users WHERE id = $1
         UNION ALL
         SELECT u.id, u.rank_level, u.is_activated, b.depth + 1
         FROM users u INNER JOIN branch b ON u.sponsor_id = b.id WHERE b.depth < 15
       )
       SELECT COALESCE(MAX(rank_level), 1)::int AS max_rank FROM branch WHERE is_activated = TRUE`,
      [leg.id]
    );
    const maxR = Number(legMaxRes.rows[0]?.max_rank || 1);
    if (maxR >= 2) legsWithV2++;
    if (maxR >= 3) legsWithV3++;
    if (maxR >= 4) legsWithV4++;
    if (maxR >= 5) legsWithV5++;
  }

  let qualifiedRank = 1;
  if (directActiveCount >= 20 && totalTeamActive >= 1500 && legsWithV5 >= 3) qualifiedRank = 6;
  else if (directActiveCount >= 12 && totalTeamActive >= 800 && legsWithV4 >= 3) qualifiedRank = 5;
  else if (directActiveCount >= 8 && totalTeamActive >= 300 && legsWithV3 >= 3) qualifiedRank = 4;
  else if (directActiveCount >= 5 && totalTeamActive >= 100 && legsWithV2 >= 3) qualifiedRank = 3;
  else if (directActiveCount >= 3 && totalTeamActive >= 20) qualifiedRank = 2;

  if (qualifiedRank > Number(user.rank_level || 1)) {
    await client.query('UPDATE users SET rank_level = $1 WHERE id = $2', [qualifiedRank, userId]);
  }
}

async function distributeDifferentialMlm(client, sourceUserId, eventType, totalAmountUsdt, referenceId) {
  let distributedTotal = 0;
  let highestPaidPct = 0;
  let highestPaidUsd = 0;
  let lastPaidRank = 0;
  let peerBonusPaidForRank = new Set();

  let currentRes = await client.query('SELECT sponsor_id FROM users WHERE id = $1', [sourceUserId]);
  let uplineId = currentRes.rows[0]?.sponsor_id;
  let hop = 0;

  while (uplineId && hop < 15) {
    hop++;
    const upRes = await client.query(
      'SELECT id, sponsor_id, rank_level, is_activated, is_owner_exempt FROM users WHERE id = $1',
      [uplineId]
    );
    if (upRes.rows.length === 0) break;
    const upline = upRes.rows[0];
    const rank = upline.is_owner_exempt ? 6 : Number(upline.rank_level || 1);

    if (upline.is_activated || upline.is_owner_exempt) {
      if (eventType === 'VIP_ACTIVATION_120') {
        const rankUsd = VIP_DIRECT_USD[rank] || 30;
        if (rankUsd > highestPaidUsd) {
          const diffUsd = rankUsd - highestPaidUsd;
          highestPaidUsd = rankUsd;
          lastPaidRank = rank;
          distributedTotal += diffUsd;
          await client.query('UPDATE wallets SET commission_balance = commission_balance + $1 WHERE user_id = $2', [diffUsd, upline.id]);
          await client.query(
            `INSERT INTO ledger_journal (event_type, reference_id, debit_account, credit_account, amount_usdt)
             VALUES ($1, $2, $3, $4, $5)`,
            [eventType, referenceId, `USER_${sourceUserId}`, `USER_${upline.id}`, diffUsd]
          );
        } else if (rank >= 3 && rank === lastPaidRank && !peerBonusPaidForRank.has(rank)) {
          const peerUsd = Number((totalAmountUsdt * 0.05).toFixed(6));
          peerBonusPaidForRank.add(rank);
          distributedTotal += peerUsd;
          await client.query('UPDATE wallets SET commission_balance = commission_balance + $1 WHERE user_id = $2', [peerUsd, upline.id]);
          await client.query(
            `INSERT INTO ledger_journal (event_type, reference_id, debit_account, credit_account, amount_usdt)
             VALUES ('PEER_VIP_BONUS', $1, $2, $3, $4)`,
            [referenceId, `USER_${sourceUserId}`, `USER_${upline.id}`, peerUsd]
          );
        }
      } else {
        const rankPct = GAS_SHARE_PCT[rank] || 0.20;
        if (rankPct > highestPaidPct) {
          const diffPct = rankPct - highestPaidPct;
          const reward = Number((totalAmountUsdt * diffPct).toFixed(6));
          highestPaidPct = rankPct;
          lastPaidRank = rank;
          distributedTotal += reward;
          await client.query('UPDATE wallets SET commission_balance = commission_balance + $1 WHERE user_id = $2', [reward, upline.id]);
          await client.query(
            `INSERT INTO ledger_journal (event_type, reference_id, debit_account, credit_account, amount_usdt)
             VALUES ($1, $2, $3, $4, $5)`,
            [eventType, referenceId, `USER_${sourceUserId}`, `USER_${upline.id}`, reward]
          );
        } else if (rank >= 3 && rank === lastPaidRank && !peerBonusPaidForRank.has(rank)) {
          const peerReward = Number((totalAmountUsdt * 0.10).toFixed(6));
          peerBonusPaidForRank.add(rank);
          distributedTotal += peerReward;
          await client.query('UPDATE wallets SET commission_balance = commission_balance + $1 WHERE user_id = $2', [peerReward, upline.id]);
          await client.query(
            `INSERT INTO ledger_journal (event_type, reference_id, debit_account, credit_account, amount_usdt)
             VALUES ('PEER_GAS_BONUS', $1, $2, $3, $4)`,
            [referenceId, `USER_${sourceUserId}`, `USER_${upline.id}`, peerReward]
          );
        }
      }
    }

    await evaluateRoyalQRankUpgrade(client, upline.id);
    uplineId = upline.sponsor_id;
  }

  const remainder = Number((totalAmountUsdt - distributedTotal).toFixed(6));
  if (remainder > 0) {
    const ownerRes = await client.query('SELECT id FROM users WHERE LOWER(email) = $1 LIMIT 1', [OWNER_EMAIL]);
    const ownerId = ownerRes.rows[0]?.id;
    if (ownerId) {
      await client.query('UPDATE wallets SET commission_balance = commission_balance + $1 WHERE user_id = $2', [remainder, ownerId]);
    }
    await client.query(
      `INSERT INTO ledger_journal (event_type, reference_id, debit_account, credit_account, amount_usdt)
       VALUES ($1, $2, $3, 'OWNER_NET_RETENTION', $4)`,
      [eventType, referenceId, `USER_${sourceUserId}`, remainder]
    );
  }
}

// =========================================================================================
// 7. AUTOMATED TRON TRC-20 PERSONAL SUB-WALLET SCANNER & AUTO-SWEEP TO MASTER VAULT
// =========================================================================================
let isDepositScannerRunning = false;

async function creditVerifiedTrc20Deposit({ userId, tronAddress, txHash, amountUsdt }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dup = await client.query('SELECT tx_hash FROM deposit_claims WHERE tx_hash = $1', [txHash]);
    if (dup.rows.length > 0) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(
      'INSERT INTO deposit_claims (tx_hash, user_id, tron_address, amount_usdt) VALUES ($1, $2, $3, $4)',
      [txHash, userId, tronAddress || MASTER_TRON_WALLET, amountUsdt]
    );
    await client.query(
      'UPDATE wallets SET gas_balance = gas_balance + $1, updated_at = NOW() WHERE user_id = $2',
      [amountUsdt, userId]
    );
    await client.query(
      `INSERT INTO ledger_journal (event_type, reference_id, debit_account, credit_account, amount_usdt)
       VALUES ('TRC20_AUTO_DEPOSIT', $1, $2, $3, $4)`,
      [txHash, tronAddress || 'TRON_NETWORK', `USER_${userId}_GAS`, amountUsdt]
    );
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    return false;
  } finally {
    client.release();
  }
}

async function scanSingleUserTrc20Deposits(userId, tronAddress) {
  let newlyCreditedUsdt = 0;
  try {
    const url = `https://api.trongrid.io/v1/accounts/${tronAddress}/transactions/trc20?only_confirmed=true&limit=20&contract_address=${USDT_TRC20_CONTRACT}`;
    const res = await fetch(url, {
      headers: TRONGRID_API_KEY ? { 'TRON-PRO-API-KEY': TRONGRID_API_KEY } : {}
    });
    if (!res.ok) return 0;
    const json = await res.json();
    const transfers = Array.isArray(json.data) ? json.data : [];

    for (const tx of transfers) {
      const toAddr = tx.to || '';
      const txHash = tx.transaction_id || '';
      const rawVal = Number(tx.value || 0);
      const amountUsdt = Number((rawVal / 1e6).toFixed(6));
      if (toAddr === tronAddress && txHash && amountUsdt >= 1) {
        const credited = await creditVerifiedTrc20Deposit({ userId, tronAddress, txHash, amountUsdt });
        if (credited) newlyCreditedUsdt += amountUsdt;
      }
    }
  } catch (e) {}
  return newlyCreditedUsdt;
}

async function scanAllUserTrc20SubWallets() {
  if (isDepositScannerRunning) return;
  isDepositScannerRunning = true;
  try {
    const subWallets = await pool.query('SELECT user_id, tron_address FROM user_deposit_wallets ORDER BY user_id ASC LIMIT 100');
    for (const row of subWallets.rows) {
      await scanSingleUserTrc20Deposits(row.user_id, row.tron_address);
    }
  } catch (e) {}
  isDepositScannerRunning = false;
}

// =========================================================================================
// 8. 24/7 LIVE BINANCE MARKET STREAM & REAL DCA QUANTITATIVE EXECUTION ENGINE
// =========================================================================================
const liveMarketPriceMap = new Map();
const priceHistoryRingMap = new Map();
let marketWs = null;
let marketMiniWs = null;
let serverWsEndpointIdx = 0;
const SERVER_WS_ENDPOINTS = [
  'wss://data-stream.binance.vision/ws/!ticker@arr',
  'wss://stream.binance.com:9443/ws/!ticker@arr'
];
const SERVER_MINI_WS_ENDPOINTS = [
  'wss://data-stream.binance.vision/ws/!miniTicker@arr',
  'wss://stream.binance.com:9443/ws/!miniTicker@arr'
];
let lastWsBroadcastMs = 0;
const sseClients = new Set();

function computeLiveRsi14(prices) {
  if (!Array.isArray(prices) || prices.length < 15) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = prices.length - 14; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  if (losses === 0) return 100;
  const rs = (gains / 14) / (losses / 14);
  return 100 - (100 / (1 + rs));
}

function ingestServerMarketArray(arr) {
  if (!Array.isArray(arr)) return;
  const compactBatch = [];
  for (const item of arr) {
    const sym = item.s || '';
    if (!sym.endsWith('USDT')) continue;
    const price = parseFloat(item.c);
    if (!price || price <= 0) continue;

    const prev = liveMarketPriceMap.get(sym);
    const openP = parseFloat(item.o || '0');
    const changePct = item.P !== undefined
      ? parseFloat(item.P)
      : (openP > 0 ? ((price - openP) / openP) * 100 : (prev?.changePct || 0));
    const quoteVol = parseFloat(item.q || '0') || prev?.quoteVol || 0;

    liveMarketPriceMap.set(sym, { price, changePct, quoteVol, updatedAt: Date.now() });
    const hist = priceHistoryRingMap.get(sym) || [];
    if (hist.length === 0 || hist[hist.length - 1] !== price) {
      hist.push(price);
      if (hist.length > 30) hist.shift();
      priceHistoryRingMap.set(sym, hist);
    }
    compactBatch.push({ s: sym, c: price, P: changePct, q: quoteVol });
  }

  if (sseClients.size > 0 && compactBatch.length > 0 && Date.now() - lastWsBroadcastMs >= 80) {
    lastWsBroadcastMs = Date.now();
    const payload = `data: ${JSON.stringify(compactBatch)}\n\n`;
    for (const clientRes of sseClients) {
      try { clientRes.write(payload); } catch (e) { sseClients.delete(clientRes); }
    }
  }
}

function startBinanceAllMarketStream() {
  const idx = serverWsEndpointIdx++;
  if (!marketMiniWs || marketMiniWs.readyState === WebSocket.CLOSED) {
    try {
      marketMiniWs = new WebSocket(SERVER_MINI_WS_ENDPOINTS[idx % SERVER_MINI_WS_ENDPOINTS.length]);
      marketMiniWs.on('message', (raw) => {
        try { ingestServerMarketArray(JSON.parse(raw.toString())); } catch (e) {}
      });
      marketMiniWs.on('close', () => {
        marketMiniWs = null;
        setTimeout(startBinanceAllMarketStream, 2000);
      });
      marketMiniWs.on('error', () => {
        try { marketMiniWs.close(); } catch (e) {}
      });
    } catch (e) {}
  }

  if (!marketWs || marketWs.readyState === WebSocket.CLOSED) {
    try {
      marketWs = new WebSocket(SERVER_WS_ENDPOINTS[idx % SERVER_WS_ENDPOINTS.length]);
      marketWs.on('message', (raw) => {
        try { ingestServerMarketArray(JSON.parse(raw.toString())); } catch (e) {}
      });
      marketWs.on('close', () => {
        marketWs = null;
        setTimeout(startBinanceAllMarketStream, 3000);
      });
      marketWs.on('error', () => {
        try { marketWs.close(); } catch (e) {}
      });
    } catch (e) {
      setTimeout(startBinanceAllMarketStream, 4000);
    }
  }
}

let isDcaLoopRunning = false;
async function evaluateActiveDcaBots() {
  if (isDcaLoopRunning) return;
  isDcaLoopRunning = true;
  try {
    const activeRes = await pool.query(
      `SELECT bs.*, u.is_activated, u.is_owner_exempt,
              w.gas_balance, w.demo_mode_active, w.demo_usdt_balance, w.demo_gas_balance, w.demo_expires_at
       FROM bot_strategies bs
       INNER JOIN users u ON u.id = bs.user_id
       INNER JOIN wallets w ON w.user_id = bs.user_id
       WHERE bs.status = 'CYCLING'`
    );

    for (const bot of activeRes.rows) {
      const isDemoActive = Boolean(bot.demo_mode_active && bot.demo_expires_at && new Date(bot.demo_expires_at) > new Date());
      if (!isDemoActive) {
        if (!bot.is_owner_exempt && (!bot.is_activated || Number(bot.gas_balance) < 20)) {
          await pool.query('UPDATE bot_strategies SET status = \'PAUSED\', updated_at = NOW() WHERE id = $1', [bot.id]);
          continue;
        }
      } else if (Number(bot.demo_gas_balance || 0) < 1) {
        await pool.query('UPDATE bot_strategies SET status = \'PAUSED\', updated_at = NOW() WHERE id = $1', [bot.id]);
        continue;
      }

      const rawSym = bot.symbol.replace('/', '').toUpperCase();
      const tick = liveMarketPriceMap.get(rawSym);
      if (!tick || !tick.price || Date.now() - tick.updatedAt > 20000) continue;

      const curPrice = tick.price;
      let posUsdt = Number(bot.total_position_usdt || 0);
      let baseQty = Number(bot.total_base_qty || 0);
      let avgEntry = Number(bot.avg_entry_price || 0);
      let currentCalls = Number(bot.current_calls || 0);
      const firstBuyBase = Number(bot.first_buy_usdt || 20);
      const initialBuySize = bot.open_position_doubling ? firstBuyBase * 2 : firstBuyBase;

      if (posUsdt <= 0 || baseQty <= 0) {
        const buyFill = await executeBinanceSpotOrder({
          userId: bot.user_id,
          symbol: bot.symbol,
          side: 'BUY',
          quoteOrderQtyUsdt: initialBuySize,
          isDemo: isDemoActive,
          fallbackPrice: curPrice
        });
        if (buyFill.success) {
          await pool.query(
            `UPDATE bot_strategies
             SET total_position_usdt = $1, total_base_qty = $2, avg_entry_price = $3,
                 current_calls = 0, highest_price_since_tp = 0, lowest_price_since_drop = 0, updated_at = NOW()
             WHERE id = $4`,
            [buyFill.filledQuoteUsdt, buyFill.filledBaseQty, buyFill.avgFillPrice, bot.id]
          );
        } else {
          await pool.query('UPDATE bot_strategies SET status = \'PAUSED\', updated_at = NOW() WHERE id = $1', [bot.id]);
        }
        continue;
      }

      const unrealizedPct = ((curPrice - avgEntry) / avgEntry) * 100;
      const targetTpPct = Number(bot.take_profit_pct || 1.3);
      const callbackPct = Number(bot.callback_pct || 0.3);

      // 1. TAKE-PROFIT WITH TRAILING CALLBACK
      if (unrealizedPct >= targetTpPct) {
        const prevHigh = Number(bot.highest_price_since_tp || 0);
        const newHigh = Math.max(prevHigh, curPrice);
        const dropFromHighPct = ((newHigh - curPrice) / newHigh) * 100;

        if (dropFromHighPct >= callbackPct) {
          const sellFill = await executeBinanceSpotOrder({
            userId: bot.user_id,
            symbol: bot.symbol,
            side: 'SELL',
            baseQuantity: baseQty,
            isDemo: isDemoActive,
            fallbackPrice: curPrice
          });
          if (sellFill.success) {
            const netProfitUsdt = Math.max(0, sellFill.filledQuoteUsdt - posUsdt);
            const fuelFee20Pct = Number((netProfitUsdt * 0.20).toFixed(6));

            if (isDemoActive) {
              await pool.query(
                `UPDATE wallets
                 SET demo_gas_balance = GREATEST(0, demo_gas_balance - $1),
                     demo_profit_usdt = demo_profit_usdt + $2,
                     updated_at = NOW()
                 WHERE user_id = $3`,
                [fuelFee20Pct, netProfitUsdt, bot.user_id]
              );
            } else {
              const client = await pool.connect();
              try {
                await client.query('BEGIN');
                await client.query(
                  `UPDATE wallets
                   SET gas_balance = GREATEST(0, gas_balance - $1),
                       total_trading_profit = total_trading_profit + $2,
                       updated_at = NOW()
                   WHERE user_id = $3`,
                  [fuelFee20Pct, netProfitUsdt, bot.user_id]
                );
                if (fuelFee20Pct > 0) {
                  await distributeDifferentialMlm(client, bot.user_id, 'GAS_FEE_20PCT', fuelFee20Pct, `${bot.symbol}_TP_${sellFill.orderId}`);
                }
                await client.query('COMMIT');
              } catch (e) {
                await client.query('ROLLBACK');
              } finally {
                client.release();
              }
            }

            const nextStatus = bot.cycle_type === 'ONE_SHOT' ? 'PAUSED' : 'CYCLING';
            await pool.query(
              `UPDATE bot_strategies
               SET status = $1, current_calls = 0, total_position_usdt = 0, total_base_qty = 0,
                   avg_entry_price = 0, highest_price_since_tp = 0, lowest_price_since_drop = 0, updated_at = NOW()
               WHERE id = $2`,
              [nextStatus, bot.id]
            );
          }
        } else if (newHigh > prevHigh) {
          await pool.query('UPDATE bot_strategies SET highest_price_since_tp = $1 WHERE id = $2', [newHigh, bot.id]);
        }
        continue;
      }

      // 2. DCA MARGIN CALL ON DIP (WITH AI RSI FILTER + BUY-IN CALLBACK)
      const maxCalls = Number(bot.margin_call_limit || 7);
      if (currentCalls < maxCalls) {
        const layers = Array.isArray(bot.layer_schedule) ? bot.layer_schedule : [];
        const nextLayer = layers[currentCalls] || {
          dropPct: Number(bot.margin_drop_pct || 3.5),
          multiple: Math.pow(2, currentCalls + 1)
        };
        const requiredDropPct = -Math.abs(Number(nextLayer.dropPct || bot.margin_drop_pct || 3.5));

        if (unrealizedPct <= requiredDropPct) {
          if (bot.ai_rsi_filter) {
            const rsi = computeLiveRsi14(priceHistoryRingMap.get(rawSym) || []);
            if (rsi > 36) continue;
          }

          const prevLow = Number(bot.lowest_price_since_drop || 0) || curPrice;
          const newLow = Math.min(prevLow, curPrice);
          const reboundFromLowPct = ((curPrice - newLow) / newLow) * 100;
          const buyCallback = Number(bot.buy_in_callback_pct || 0.5);

          if (reboundFromLowPct >= buyCallback) {
            const callBuyUsdt = Number((firstBuyBase * Number(nextLayer.multiple || 2)).toFixed(2));
            const callFill = await executeBinanceSpotOrder({
              userId: bot.user_id,
              symbol: bot.symbol,
              side: 'BUY',
              quoteOrderQtyUsdt: callBuyUsdt,
              isDemo: isDemoActive,
              fallbackPrice: curPrice
            });
            if (callFill.success) {
              const updatedPosUsdt = posUsdt + callFill.filledQuoteUsdt;
              const updatedBaseQty = baseQty + callFill.filledBaseQty;
              const updatedAvgEntry = updatedPosUsdt / updatedBaseQty;
              await pool.query(
                `UPDATE bot_strategies
                 SET current_calls = $1, total_position_usdt = $2, total_base_qty = $3,
                     avg_entry_price = $4, lowest_price_since_drop = 0, highest_price_since_tp = 0, updated_at = NOW()
                 WHERE id = $5`,
                [currentCalls + 1, updatedPosUsdt, updatedBaseQty, updatedAvgEntry, bot.id]
              );
            }
          } else if (newLow !== prevLow || !bot.lowest_price_since_drop) {
            await pool.query('UPDATE bot_strategies SET lowest_price_since_drop = $1 WHERE id = $2', [newLow, bot.id]);
          }
        }
      }
    }
  } catch (e) {}
  isDcaLoopRunning = false;
}

// =========================================================================================
// 9. API ROUTES
// =========================================================================================
app.get('/api/v1/health', (req, res) => {
  res.json({
    success: true,
    service: 'BharatQ Quantitative Engine (Singapore)',
    wsConnected: Boolean((marketWs && marketWs.readyState === WebSocket.OPEN) || (marketMiniWs && marketMiniWs.readyState === WebSocket.OPEN)),
    trackedPairs: liveMarketPriceMap.size,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/v1/exchange/whitelist-ips', async (req, res) => {
  let outboundIp = '';
  try {
    const ipRes = await fetch('https://api.ipify.org?format=json');
    if (ipRes.ok) {
      const ipJson = await ipRes.json();
      outboundIp = ipJson.ip || '';
    }
  } catch (e) {}
  res.json({
    success: true,
    ipGroupString: outboundIp || 'Fetching Render Singapore outbound IP...'
  });
});

app.get('/api/v1/leaderboard', async (req, res) => {
  try {
    const topRes = await pool.query(
      `SELECT u.uid, u.email, u.rank_level,
              (SELECT COUNT(*)::int FROM users d WHERE d.sponsor_id = u.id AND d.is_activated = TRUE) AS direct_count
       FROM users u
       WHERE u.is_activated = TRUE OR u.is_owner_exempt = TRUE
       ORDER BY u.rank_level DESC, direct_count DESC, u.id ASC
       LIMIT 25`
    );
    const leaders = topRes.rows.map(r => ({
      uid: r.uid,
      masked_email: maskEmailAddress(r.email),
      rank_level: r.rank_level || 1,
      direct_count: r.direct_count || 0
    }));
    res.json({ success: true, leaders });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to load leaderboard' });
  }
});

let cachedRestTickers = { fetchedAt: 0, data: [] };
app.get('/api/v1/market/tickers', async (req, res) => {
  if (liveMarketPriceMap.size >= 40) {
    const fromWs = [];
    for (const [symbol, info] of liveMarketPriceMap.entries()) {
      fromWs.push({
        symbol,
        lastPrice: String(info.price),
        priceChangePercent: String(info.changePct || 0),
        quoteVolume: String(info.quoteVol || 100000)
      });
    }
    return res.json(fromWs);
  }
  if (cachedRestTickers.data.length > 0 && Date.now() - cachedRestTickers.fetchedAt < 60000) {
    return res.json(cachedRestTickers.data);
  }
  try {
    const r = await fetch('https://data-api.binance.vision/api/v3/ticker/24hr');
    if (r.ok) {
      const data = await r.json();
      if (Array.isArray(data) && data.length > 40) {
        cachedRestTickers = { fetchedAt: Date.now(), data };
        return res.json(data);
      }
    }
  } catch (e) {}
  res.json(cachedRestTickers.data || []);
});

app.get('/api/v1/market/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  if (liveMarketPriceMap.size > 0) {
    const initialSnapshot = [];
    for (const [s, info] of liveMarketPriceMap.entries()) {
      initialSnapshot.push({ s, c: info.price, P: info.changePct || 0, q: info.quoteVol || 0 });
    }
    try { res.write(`data: ${JSON.stringify(initialSnapshot)}\n\n`); } catch (e) {}
  }
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// REGISTER
app.post('/api/v1/auth/register', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const sponsorCode = String(req.body.sponsorCode || OWNER_REFERRAL_CODE).trim().toUpperCase();
  const mobileNumber = String(req.body.mobileNumber || '').trim();
  const region = String(req.body.region || 'IN').trim();

  if (!email || !email.includes('@')) return res.status(400).json({ success: false, error: 'Valid email is required' });
  if (password.length < 8) return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });

  try {
    const existing = await pool.query('SELECT id FROM users WHERE LOWER(email) = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ success: false, error: 'Email already registered — please Log In instead' });
    }

    const spRes = await pool.query('SELECT id FROM users WHERE UPPER(referral_code) = $1 LIMIT 1', [sponsorCode]);
    if (spRes.rows.length === 0) {
      return res.status(400).json({ success: false, error: `Invalid invitation code "${sponsorCode}". Use BHARAT1 or a valid sponsor code.` });
    }
    const sponsorId = spRes.rows[0].id;

    const ownerFlag = isPlatformOwner(email, mobileNumber);
    const refCode = ownerFlag ? OWNER_REFERRAL_CODE : await generateUniqueReferralCode();
    const passHash = await bcrypt.hash(password, 10);

    const ins = await pool.query(
      `INSERT INTO users (email, mobile_number, password_hash, region, referral_code, sponsor_id, rank_level, is_activated, is_owner_exempt, activated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [email, mobileNumber, passHash, region, refCode, sponsorId, ownerFlag ? 6 : 1, ownerFlag, ownerFlag, ownerFlag ? new Date() : null]
    );
    const newUser = ins.rows[0];
    const uid = 100000 + newUser.id;
    await pool.query('UPDATE users SET uid = $1 WHERE id = $2', [uid, newUser.id]);
    await pool.query('INSERT INTO wallets (user_id, gas_balance, commission_balance) VALUES ($1, 0, 0)', [newUser.id]);
    const depositAddr = await getOrCreateUserTrc20DepositWallet(newUser.id);

    const token = jwt.sign({ userId: newUser.id, email: newUser.email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({
      success: true,
      token,
      ownerFreeSubscription: ownerFlag,
      personalDepositAddress: depositAddr,
      user: { ...newUser, uid, gas_balance: 0, commission_balance: 0 }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Registration error: ' + err.message });
  }
});

// LOGIN
app.post('/api/v1/auth/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!email || !password) return res.status(400).json({ success: false, error: 'Email and password are required' });

  try {
    const uRes = await pool.query('SELECT * FROM users WHERE LOWER(email) = $1 LIMIT 1', [email]);
    if (uRes.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Account not found — please Register first' });
    }
    const user = uRes.rows[0];
    if (!user.password_hash) {
      return res.status(401).json({ success: false, error: 'Please use "Login with Email Code" for this account' });
    }
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ success: false, error: 'Incorrect password' });

    const wRes = await pool.query('SELECT * FROM wallets WHERE user_id = $1', [user.id]);
    const wallet = wRes.rows[0] || { gas_balance: 0, commission_balance: 0, total_trading_profit: 0 };
    const depositAddr = await getOrCreateUserTrc20DepositWallet(user.id);
    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });

    res.json({
      success: true,
      token,
      ownerFreeSubscription: Boolean(user.is_owner_exempt),
      personalDepositAddress: depositAddr,
      user: {
        ...user,
        gas_balance: Number(wallet.gas_balance),
        commission_balance: Number(wallet.commission_balance),
        total_trading_profit: Number(wallet.total_trading_profit)
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Login failed: ' + err.message });
  }
});

// VERIFY OTP / SUPABASE SESSION SYNC
app.post('/api/v1/auth/verify-otp', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const mobileNumber = String(req.body.mobileNumber || '').trim();
  const sponsorCode = String(req.body.sponsorCode || OWNER_REFERRAL_CODE).trim().toUpperCase();
  if (!email || !email.includes('@')) return res.status(400).json({ success: false, error: 'Valid email required' });

  try {
    let uRes = await pool.query('SELECT * FROM users WHERE LOWER(email) = $1 LIMIT 1', [email]);
    let user;
    if (uRes.rows.length === 0) {
      const spRes = await pool.query('SELECT id FROM users WHERE UPPER(referral_code) = $1 LIMIT 1', [sponsorCode]);
      const sponsorId = spRes.rows[0]?.id || (await pool.query('SELECT id FROM users WHERE referral_code = $1', [OWNER_REFERRAL_CODE])).rows[0]?.id;
      const ownerFlag = isPlatformOwner(email, mobileNumber);
      const refCode = ownerFlag ? OWNER_REFERRAL_CODE : await generateUniqueReferralCode();
      const ins = await pool.query(
        `INSERT INTO users (email, mobile_number, referral_code, sponsor_id, rank_level, is_activated, is_owner_exempt, activated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [email, mobileNumber, refCode, sponsorId, ownerFlag ? 6 : 1, ownerFlag, ownerFlag, ownerFlag ? new Date() : null]
      );
      user = ins.rows[0];
      const uid = 100000 + user.id;
      await pool.query('UPDATE users SET uid = $1 WHERE id = $2', [uid, user.id]);
      user.uid = uid;
      await pool.query('INSERT INTO wallets (user_id, gas_balance, commission_balance) VALUES ($1, 0, 0)', [user.id]);
    } else {
      user = uRes.rows[0];
    }

    const wRes = await pool.query('SELECT * FROM wallets WHERE user_id = $1', [user.id]);
    const wallet = wRes.rows[0] || { gas_balance: 0, commission_balance: 0, total_trading_profit: 0 };
    const depositAddr = await getOrCreateUserTrc20DepositWallet(user.id);
    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });

    res.json({
      success: true,
      token,
      ownerFreeSubscription: Boolean(user.is_owner_exempt),
      personalDepositAddress: depositAddr,
      user: {
        ...user,
        gas_balance: Number(wallet.gas_balance),
        commission_balance: Number(wallet.commission_balance),
        total_trading_profit: Number(wallet.total_trading_profit)
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Session verification failed' });
  }
});

// FULL REAL USER PROFILE, TEAM TREE (15 LEVELS), LEDGER, STRATEGIES & CIRCLES
app.get('/api/v1/user/profile', requireAuth, async (req, res) => {
  const userId = req.auth.userId;
  try {
    const uRes = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (uRes.rows.length === 0) return res.status(404).json({ success: false, error: 'User not found' });
    const user = uRes.rows[0];

    const wRes = await pool.query('SELECT * FROM wallets WHERE user_id = $1', [userId]);
    const wallet = wRes.rows[0] || { gas_balance: 0, commission_balance: 0, total_trading_profit: 0 };
    const depositAddr = await getOrCreateUserTrc20DepositWallet(userId);

    const exRes = await pool.query(
      'SELECT exchange_name, api_key, status FROM exchange_credentials WHERE user_id = $1 AND status = \'ACTIVE\'',
      [userId]
    );

    const teamRes = await pool.query(
      `WITH RECURSIVE downline AS (
         SELECT u.id, u.uid, u.email, u.rank_level, u.is_activated, u.created_at,
                1 AS gen_level, s.email AS sponsor_email, s.referral_code AS sponsor_code
         FROM users u
         LEFT JOIN users s ON s.id = u.sponsor_id
         WHERE u.sponsor_id = $1
         UNION ALL
         SELECT u.id, u.uid, u.email, u.rank_level, u.is_activated, u.created_at,
                d.gen_level + 1, s.email AS sponsor_email, s.referral_code AS sponsor_code
         FROM users u
         INNER JOIN downline d ON u.sponsor_id = d.id
         LEFT JOIN users s ON s.id = u.sponsor_id
         WHERE d.gen_level < 15
       )
       SELECT * FROM downline ORDER BY gen_level ASC, created_at DESC LIMIT 250`,
      [userId]
    );

    const logsRes = await pool.query(
      `SELECT * FROM ledger_journal
       WHERE credit_account IN ($1, $2) OR debit_account IN ($1, $2)
       ORDER BY created_at DESC LIMIT 50`,
      [`USER_${userId}`, `USER_${userId}_GAS`]
    );

    const stratRes = await pool.query('SELECT * FROM bot_strategies WHERE user_id = $1', [userId]);
    const todayProfitRes = await pool.query(
      `SELECT COALESCE(SUM(amount_usdt / 0.20), 0) AS today_net_profit
       FROM ledger_journal
       WHERE event_type = 'GAS_FEE_20PCT'
         AND debit_account = $1
         AND created_at >= DATE_TRUNC('day', NOW())`,
      [`USER_${userId}`]
    );
    const todayRealProfit = Number(todayProfitRes.rows[0]?.today_net_profit || 0);
    const circlesRes = await pool.query(
      `SELECT sc.*, u.email AS owner_email, u.rank_level AS owner_rank
       FROM strategy_circles sc
       INNER JOIN users u ON u.id = sc.owner_user_id
       WHERE sc.is_active = TRUE
       ORDER BY sc.created_at DESC`
    );
    const syncedRes = await pool.query('SELECT circle_id FROM circle_subscriptions WHERE user_id = $1', [userId]);

    let platformStats = null;
    if (user.is_owner_exempt) {
      const pStats = await pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM users) AS total_users,
           (SELECT COUNT(*)::int FROM users WHERE is_activated = TRUE) AS active_vips,
           (SELECT COALESCE(SUM(gas_balance), 0) FROM wallets) AS total_gas_balance`
      );
      platformStats = {
        totalUsers: pStats.rows[0].total_users,
        activeVips: pStats.rows[0].active_vips,
        totalGasBalance: Number(pStats.rows[0].total_gas_balance)
      };
    }

    res.json({
      success: true,
      user,
      wallet,
      todayProfit: todayRealProfit,
      personalDepositAddress: depositAddr,
      boundExchanges: exRes.rows,
      directTeam: teamRes.rows.filter(r => r.gen_level === 1),
      fullDownlineTeam: teamRes.rows,
      commissionLogs: logsRes.rows,
      botStrategies: stratRes.rows,
      circles: circlesRes.rows,
      syncedCircleIds: syncedRes.rows.map(r => r.circle_id),
      platformStats
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to load profile' });
  }
});

// TOGGLE 24-HOUR $10,000 FREE PAPER-TRADING SANDBOX
app.post('/api/v1/demo/toggle', requireAuth, async (req, res) => {
  const userId = req.auth.userId;
  const enable = Boolean(req.body.enable);
  try {
    if (enable) {
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await pool.query(
        `UPDATE wallets
         SET demo_mode_active = TRUE,
             demo_usdt_balance = 10000.000000,
             demo_gas_balance = 500.000000,
             demo_profit_usdt = 0.000000,
             demo_expires_at = $1,
             updated_at = NOW()
         WHERE user_id = $2`,
        [expiresAt, userId]
      );
    } else {
      await pool.query(
        `UPDATE wallets
         SET demo_mode_active = FALSE,
             demo_usdt_balance = 0,
             demo_gas_balance = 0,
             demo_expires_at = NULL,
             updated_at = NOW()
         WHERE user_id = $1`,
        [userId]
      );
      await pool.query(
        `UPDATE bot_strategies
         SET status = 'PAUSED', current_calls = 0, total_position_usdt = 0, total_base_qty = 0,
             avg_entry_price = 0, highest_price_since_tp = 0, lowest_price_since_drop = 0, updated_at = NOW()
         WHERE user_id = $1`,
        [userId]
      );
    }
    const wRes = await pool.query(
      'SELECT demo_mode_active, demo_usdt_balance, demo_gas_balance, demo_profit_usdt, demo_expires_at FROM wallets WHERE user_id = $1',
      [userId]
    );
    res.json({ success: true, demo: wRes.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to toggle 24H demo sandbox: ' + err.message });
  }
});

// DEPOSIT ADDRESS & LIVE AUTO-SCAN
app.get('/api/v1/wallet/deposit-address', requireAuth, async (req, res) => {
  const userId = req.auth.userId;
  try {
    const depositAddress = await getOrCreateUserTrc20DepositWallet(userId);
    const newlyCreditedUsdt = await scanSingleUserTrc20Deposits(userId, depositAddress);
    const wRes = await pool.query('SELECT gas_balance FROM wallets WHERE user_id = $1', [userId]);
    res.json({
      success: true,
      depositAddress,
      newlyCreditedUsdt,
      newGasBalance: Number(wRes.rows[0]?.gas_balance || 0)
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to fetch deposit address' });
  }
});

// OPTIONAL MANUAL TXID CLAIM
app.post('/api/v1/wallet/claim-txid', requireAuth, async (req, res) => {
  const userId = req.auth.userId;
  const txHash = String(req.body.txHash || '').trim();
  if (!txHash || txHash.length !== 64) {
    return res.status(400).json({ success: false, error: 'Invalid 64-character TRON transaction hash' });
  }
  try {
    const userDepositAddr = await getOrCreateUserTrc20DepositWallet(userId);
    const infoRes = await fetch(`https://api.trongrid.io/wallet/gettransactioninfobyid?value=${txHash}`, {
      headers: TRONGRID_API_KEY ? { 'TRON-PRO-API-KEY': TRONGRID_API_KEY } : {}
    });
    const info = await infoRes.json();
    if (!info || !info.id) {
      return res.status(404).json({ success: false, error: 'Transaction not confirmed on TRON mainnet yet' });
    }
    const logs = Array.isArray(info.log) ? info.log : [];
    const transferTopic = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    const tronWeb = createTronClient();
    let matchedUsdt = 0;

    for (const lg of logs) {
      const contractBase58 = tronWeb.address.fromHex('41' + lg.address);
      if (contractBase58 === USDT_TRC20_CONTRACT && lg.topics && lg.topics[0] === transferTopic && lg.topics[2]) {
        const toAddr = tronWeb.address.fromHex('41' + lg.topics[2].slice(24));
        if (toAddr === userDepositAddr || toAddr === MASTER_TRON_WALLET) {
          matchedUsdt = Number((parseInt(lg.data, 16) / 1e6).toFixed(6));
          break;
        }
      }
    }

    if (matchedUsdt <= 0) {
      return res.status(400).json({ success: false, error: 'No USDT TRC-20 transfer to your deposit address found in this TXID' });
    }

    const credited = await creditVerifiedTrc20Deposit({
      userId,
      tronAddress: userDepositAddr,
      txHash,
      amountUsdt: matchedUsdt
    });
    if (!credited) {
      return res.status(409).json({ success: false, error: 'This TXID has already been credited' });
    }
    const wRes = await pool.query('SELECT gas_balance FROM wallets WHERE user_id = $1', [userId]);
    res.json({
      success: true,
      creditedAmountUsdt: matchedUsdt,
      newGasBalance: Number(wRes.rows[0]?.gas_balance || 0),
      message: `Verified on TRON! +$${matchedUsdt.toFixed(2)} USDT credited`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'TXID verification error: ' + err.message });
  }
});

// ACTIVATE $120 ANNUAL VIP LICENSE + REAL DIFFERENTIAL MLM DISTRIBUTION
app.post('/api/v1/user/activate', requireAuth, async (req, res) => {
  const userId = req.auth.userId;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const uRes = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const user = uRes.rows[0];
    if (!user) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    if (user.is_activated || user.is_owner_exempt) {
      await client.query('ROLLBACK');
      return res.json({ success: true, message: 'VIP already active' });
    }
    const wRes = await client.query('SELECT gas_balance FROM wallets WHERE user_id = $1 FOR UPDATE', [userId]);
    const gasBal = Number(wRes.rows[0]?.gas_balance || 0);
    if (gasBal < 120) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'Insufficient balance — minimum 120.00 USDT required to activate VIP' });
    }

    await client.query('UPDATE wallets SET gas_balance = gas_balance - 120, updated_at = NOW() WHERE user_id = $1', [userId]);
    await client.query('UPDATE users SET is_activated = TRUE, activated_at = NOW() WHERE id = $1', [userId]);

    await distributeDifferentialMlm(client, userId, 'VIP_ACTIVATION_120', 120, `VIP_ACT_${userId}_${Date.now()}`);
    await client.query('COMMIT');

    const updatedW = await pool.query('SELECT gas_balance FROM wallets WHERE user_id = $1', [userId]);
    res.json({
      success: true,
      remainingGas: Number(updatedW.rows[0]?.gas_balance || 0),
      message: 'VIP License Activated for 365 Days!'
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: 'Activation failed: ' + err.message });
  } finally {
    client.release();
  }
});

// TRANSFER REWARD BALANCE -> FUEL GAS WALLET (0 FEE)
app.post('/api/v1/wallet/transfer', requireAuth, async (req, res) => {
  const userId = req.auth.userId;
  const amount = Number(req.body.amountUsdt || 0);
  if (amount <= 0) return res.status(400).json({ success: false, error: 'Invalid transfer amount' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const wRes = await client.query('SELECT commission_balance, gas_balance FROM wallets WHERE user_id = $1 FOR UPDATE', [userId]);
    const commBal = Number(wRes.rows[0]?.commission_balance || 0);
    if (commBal < amount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'Insufficient Reward Wallet balance' });
    }
    const upd = await client.query(
      `UPDATE wallets
       SET commission_balance = commission_balance - $1, gas_balance = gas_balance + $1, updated_at = NOW()
       WHERE user_id = $2 RETURNING commission_balance, gas_balance`,
      [amount, userId]
    );
    await client.query(
      `INSERT INTO ledger_journal (event_type, reference_id, debit_account, credit_account, amount_usdt)
       VALUES ('REWARD_TO_GAS_TRANSFER', $1, $2, $3, $4)`,
      [`TF_${Date.now()}`, `USER_${userId}_REWARD`, `USER_${userId}_GAS`, amount]
    );
    await client.query('COMMIT');
    res.json({
      success: true,
      newCommissionBalance: Number(upd.rows[0].commission_balance),
      newGasBalance: Number(upd.rows[0].gas_balance)
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: 'Transfer failed' });
  } finally {
    client.release();
  }
});

// WITHDRAW REWARD BALANCE TO EXTERNAL TRC-20 ADDRESS (2 USDT NETWORK FEE)
app.post('/api/v1/wallet/withdraw', requireAuth, async (req, res) => {
  const userId = req.auth.userId;
  const dest = String(req.body.destinationTrc20 || '').trim();
  const amount = Number(req.body.amountUsdt || 0);
  const fee = 2;

  if (!dest.startsWith('T') || dest.length < 30 || amount < 10) {
    return res.status(400).json({ success: false, error: 'Valid TRC-20 address and min 10 USDT required' });
  }

  const netSend = Number((amount - fee).toFixed(6));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const wRes = await client.query('SELECT commission_balance FROM wallets WHERE user_id = $1 FOR UPDATE', [userId]);
    const commBal = Number(wRes.rows[0]?.commission_balance || 0);
    if (commBal < amount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'Insufficient Reward Wallet balance' });
    }
    const upd = await client.query(
      'UPDATE wallets SET commission_balance = commission_balance - $1, updated_at = NOW() WHERE user_id = $2 RETURNING commission_balance',
      [amount, userId]
    );

    let txHash = null;
    let status = 'PENDING_MANUAL_PAYOUT';
    if (HOT_WALLET_PRIVATE_KEY) {
      try {
        const tronWeb = createTronClient(HOT_WALLET_PRIVATE_KEY);
        const contract = await tronWeb.contract().at(USDT_TRC20_CONTRACT);
        const sunAmount = Math.round(netSend * 1e6);
        txHash = await contract.transfer(dest, sunAmount).send();
        status = 'BROADCASTED_ONCHAIN';
      } catch (tronErr) {
        status = 'HOT_WALLET_RETRY_QUEUED';
      }
    }

    await client.query(
      `INSERT INTO withdrawal_requests (user_id, destination_trc20, gross_amount, network_fee, net_sent, tx_hash, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, dest, amount, fee, netSend, txHash, status]
    );
    await client.query(
      `INSERT INTO ledger_journal (event_type, reference_id, debit_account, credit_account, amount_usdt)
       VALUES ('TRC20_WITHDRAWAL', $1, $2, $3, $4)`,
      [txHash || status, `USER_${userId}_REWARD`, dest, amount]
    );
    await client.query('COMMIT');
    res.json({
      success: true,
      netReceivedUsdt: netSend,
      remainingCommission: Number(upd.rows[0].commission_balance),
      txHash,
      status
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: 'Withdrawal failed: ' + err.message });
  } finally {
    client.release();
  }
});

// REAL EXCHANGE API BINDING (WITH LIVE HMAC-SHA256 CHECK)
app.post('/api/v1/exchange/bind', requireAuth, async (req, res) => {
  const userId = req.auth.userId;
  const exchangeName = String(req.body.exchangeName || 'BINANCE').toUpperCase();
  const apiKey = String(req.body.apiKey || '').trim();
  const apiSecret = String(req.body.apiSecret || '').trim();

  if (!apiKey || !apiSecret) {
    return res.status(400).json({ success: false, error: 'API Key and Secret Key are required' });
  }

  const check = await verifyExchangeCredentialsLive(exchangeName, apiKey, apiSecret);
  if (!check.valid) {
    return res.status(400).json({ success: false, error: check.error, fixHint: check.fixHint });
  }

  const encryptedSecret = encryptApiSecret(apiSecret);
  await pool.query(
    `INSERT INTO exchange_credentials (user_id, exchange_name, api_key, encrypted_secret, status)
     VALUES ($1, $2, $3, $4, 'ACTIVE')
     ON CONFLICT (user_id, exchange_name)
     DO UPDATE SET api_key = EXCLUDED.api_key, encrypted_secret = EXCLUDED.encrypted_secret, status = 'ACTIVE', created_at = NOW()`,
    [userId, exchangeName, apiKey, encryptedSecret]
  );

  res.json({
    success: true,
    exchangeName,
    spotUsdtBalance: check.spotUsdtBalance,
    message: check.message
  });
});

// SAVE / START / PAUSE BOT STRATEGY (EXECUTES REAL FIRST SPOT BUY BEFORE MARKING CYCLING)
app.post('/api/v1/bot/strategy', requireAuth, async (req, res) => {
  const userId = req.auth.userId;
  const symbol = String(req.body.symbol || '').toUpperCase();
  const desiredStatus = String(req.body.status || 'PAUSED').toUpperCase();
  const strategyMode = String(req.body.strategyMode || 'SUB_BIN_REALTIME');
  const cycleType = String(req.body.cycleType || 'CYCLE');
  const firstBuyUsdt = Math.max(10, Number(req.body.firstBuyUsdt || 20));
  const openPositionDoubling = Boolean(req.body.openPositionDoubling);
  const marginCallLimit = Math.max(1, Math.min(15, Number(req.body.marginCallLimit || 7)));
  const marginDropPct = Math.max(0.2, Number(req.body.marginDropPct || 3.5));
  const takeProfitPct = Math.max(0.2, Number(req.body.takeProfitPct || 1.3));
  const callbackPct = Math.max(0.05, Number(req.body.callbackPct || 0.3));
  const buyInCallbackPct = Math.max(0.05, Number(req.body.buyInCallbackPct || 0.5));
  const subBinTpPct = Math.max(0.2, Number(req.body.subBinTpPct || 1.3));
  const aiRsiFilter = req.body.aiRsiFilter !== false;
  const aiDynamicTp = req.body.aiDynamicTp !== false;
  const autoCompound = req.body.autoCompound !== false;
  const layerSchedule = Array.isArray(req.body.layerSchedule) ? req.body.layerSchedule : [];
  const clientLivePrice = Number(req.body.clientLivePrice || 0);

  if (!symbol || !symbol.includes('/')) {
    return res.status(400).json({ success: false, error: 'Invalid trading pair symbol' });
  }

  try {
    const uRes = await pool.query(
      `SELECT u.is_activated, u.is_owner_exempt,
              w.gas_balance, w.demo_mode_active, w.demo_usdt_balance, w.demo_gas_balance, w.demo_expires_at
       FROM users u
       INNER JOIN wallets w ON w.user_id = u.id
       WHERE u.id = $1`,
      [userId]
    );
    const uRow = uRes.rows[0];
    const isDemoActive = Boolean(uRow && uRow.demo_mode_active && uRow.demo_expires_at && new Date(uRow.demo_expires_at) > new Date());

    if (!isDemoActive) {
      if (!uRow || (!uRow.is_owner_exempt && !uRow.is_activated)) {
        return res.status(403).json({ success: false, error: 'Activate $120/Yr VIP License before starting the bot.' });
      }
      if (!uRow.is_owner_exempt && Number(uRow.gas_balance) < 20) {
        return res.status(400).json({ success: false, error: 'Minimum 20.00 USDT Fuel Gas balance required to start trading!' });
      }
    } else if (Number(uRow.demo_gas_balance || 0) < 1) {
      return res.status(400).json({ success: false, error: '24H Demo Fuel Gas exhausted — restart 24H $10K Demo.' });
    }

    const existingRes = await pool.query(
      'SELECT total_position_usdt, total_base_qty, avg_entry_price, current_calls FROM bot_strategies WHERE user_id = $1 AND symbol = $2',
      [userId, symbol]
    );
    const existingRow = existingRes.rows[0];
    const hasOpenPosition = existingRow && Number(existingRow.total_position_usdt) > 0 && Number(existingRow.total_base_qty) > 0 && Number(existingRow.avg_entry_price) > 0;

    let initialPosUsdt = hasOpenPosition ? Number(existingRow.total_position_usdt) : 0;
    let initialBaseQty = hasOpenPosition ? Number(existingRow.total_base_qty) : 0;
    let initialEntryPrice = hasOpenPosition ? Number(existingRow.avg_entry_price) : 0;

    if (desiredStatus === 'CYCLING' && !hasOpenPosition) {
      const initialBuySize = openPositionDoubling ? firstBuyUsdt * 2 : firstBuyUsdt;

      if (!isDemoActive) {
        const creds = await getUserActiveExchangeCreds(userId, 'BINANCE');
        if (!creds) {
          return res.status(400).json({ success: false, error: 'Please bind your Binance Spot API first!' });
        }
        const liveCheck = await verifyExchangeCredentialsLive(creds.exchangeName, creds.apiKey, creds.apiSecret);
        if (!liveCheck.valid && !String(liveCheck.error || '').includes('cooldown')) {
          return res.status(400).json({ success: false, error: liveCheck.error || 'Unable to verify Binance Spot balance.' });
        }
        if (liveCheck.valid && liveCheck.spotUsdtBalance !== null && liveCheck.spotUsdtBalance < initialBuySize) {
          return res.status(400).json({
            success: false,
            error: `Insufficient Binance Spot USDT Balance ($${liveCheck.spotUsdtBalance.toFixed(2)} USDT available, $${initialBuySize.toFixed(2)} USDT required). Deposit USDT into your Binance Spot Wallet first.`
          });
        }
      }

      const buyFill = await executeBinanceSpotOrder({
        userId,
        symbol,
        side: 'BUY',
        quoteOrderQtyUsdt: initialBuySize,
        isDemo: isDemoActive,
        fallbackPrice: clientLivePrice
      });
      if (!buyFill.success) {
        return res.status(400).json({
          success: false,
          requiresClientRelay: Boolean(buyFill.requiresClientRelay),
          relayOrder: buyFill.relayOrder || null,
          error: buyFill.error || 'Spot first buy order failed — bot remains Paused.'
        });
      }
      initialPosUsdt = buyFill.filledQuoteUsdt;
      initialBaseQty = buyFill.filledBaseQty;
      initialEntryPrice = buyFill.avgFillPrice;
    }

    await pool.query(
      `INSERT INTO bot_strategies (
         user_id, symbol, status, strategy_mode, cycle_type, first_buy_usdt, open_position_doubling,
         margin_call_limit, margin_drop_pct, take_profit_pct, callback_pct, buy_in_callback_pct, sub_bin_tp_pct,
         ai_rsi_filter, ai_dynamic_tp, auto_compound, layer_schedule,
         total_position_usdt, total_base_qty, avg_entry_price, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19,$20,NOW())
       ON CONFLICT (user_id, symbol)
       DO UPDATE SET
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
         layer_schedule = EXCLUDED.layer_schedule,
         total_position_usdt = EXCLUDED.total_position_usdt,
         total_base_qty = EXCLUDED.total_base_qty,
         avg_entry_price = EXCLUDED.avg_entry_price,
         updated_at = NOW()`,
      [
        userId, symbol, desiredStatus, strategyMode, cycleType, firstBuyUsdt, openPositionDoubling,
        marginCallLimit, marginDropPct, takeProfitPct, callbackPct, buyInCallbackPct, subBinTpPct,
        aiRsiFilter, aiDynamicTp, autoCompound, JSON.stringify(layerSchedule),
        initialPosUsdt, initialBaseQty, initialEntryPrice
      ]
    );

    return res.json({
      success: true,
      status: desiredStatus,
      positionUsdt: initialPosUsdt,
      baseQty: initialBaseQty,
      avgEntryPrice: initialEntryPrice,
      calls: existingRow ? Number(existingRow.current_calls || 0) : 0,
      message: desiredStatus === 'CYCLING'
        ? (isDemoActive ? `24H Demo order filled on ${symbol} — bot running 24/7` : `Real Spot first buy filled on ${symbol} — bot running 24/7`)
        : `Strategy updated for ${symbol}`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to update bot strategy: ' + err.message });
  }
});

// MANUAL BUY (REPLENISH) & MANUAL SELL (CLEARANCE)
app.post('/api/v1/bot/manual-action', requireAuth, async (req, res) => {
  const userId = req.auth.userId;
  const symbol = String(req.body.symbol || '').toUpperCase();
  const action = String(req.body.action || '').toUpperCase();
  const extraUsdt = Number(req.body.extraUsdt || 20);
  const clientDirectFill = req.body.clientDirectFill || null;
  const clientLivePrice = Number(req.body.clientLivePrice || 0);

  try {
    const wRes = await pool.query(
      'SELECT demo_mode_active, demo_expires_at FROM wallets WHERE user_id = $1',
      [userId]
    );
    const wRow = wRes.rows[0];
    const isDemoActive = Boolean(wRow && wRow.demo_mode_active && wRow.demo_expires_at && new Date(wRow.demo_expires_at) > new Date());

    const bRes = await pool.query('SELECT * FROM bot_strategies WHERE user_id = $1 AND symbol = $2', [userId, symbol]);
    const bot = bRes.rows[0] || {
      current_calls: 0,
      total_position_usdt: 0,
      total_base_qty: 0,
      avg_entry_price: 0
    };

    if (action === 'MANUAL_REPLENISH') {
      let fill = clientDirectFill
        ? {
            success: true,
            orderId: clientDirectFill.orderId,
            filledQuoteUsdt: Number(clientDirectFill.filledQuoteUsdt || extraUsdt),
            filledBaseQty: Number(clientDirectFill.filledBaseQty || 0),
            avgFillPrice: Number(clientDirectFill.filledBaseQty) > 0
              ? Number(clientDirectFill.filledQuoteUsdt) / Number(clientDirectFill.filledBaseQty)
              : 0
          }
        : await executeBinanceSpotOrder({
            userId,
            symbol,
            side: 'BUY',
            quoteOrderQtyUsdt: extraUsdt,
            isDemo: isDemoActive,
            fallbackPrice: clientLivePrice
          });

      if (!fill.success) {
        return res.status(400).json({
          success: false,
          requiresClientRelay: Boolean(fill.requiresClientRelay),
          relayOrder: fill.relayOrder || null,
          error: fill.error
        });
      }

      const newPos = Number(bot.total_position_usdt || 0) + fill.filledQuoteUsdt;
      const newQty = Number(bot.total_base_qty || 0) + fill.filledBaseQty;
      const newAvg = newQty > 0 ? newPos / newQty : fill.avgFillPrice;
      const newCalls = Number(bot.current_calls || 0) + 1;

      await pool.query(
        `INSERT INTO bot_strategies (user_id, symbol, status, current_calls, total_position_usdt, total_base_qty, avg_entry_price, updated_at)
         VALUES ($1, $2, 'CYCLING', $3, $4, $5, $6, NOW())
         ON CONFLICT (user_id, symbol)
         DO UPDATE SET
           current_calls = EXCLUDED.current_calls,
           total_position_usdt = EXCLUDED.total_position_usdt,
           total_base_qty = EXCLUDED.total_base_qty,
           avg_entry_price = EXCLUDED.avg_entry_price,
           updated_at = NOW()`,
        [userId, symbol, newCalls, newPos, newQty, newAvg]
      );

      return res.json({
        success: true,
        calls: newCalls,
        positionUsdt: newPos,
        baseQty: newQty,
        avgEntryPrice: newAvg,
        message: `Bought $${fill.filledQuoteUsdt.toFixed(2)} USDT of ${symbol}!`
      });
    }

    if (action === 'SELL_ALL') {
      let fill = clientDirectFill
        ? {
            success: true,
            orderId: clientDirectFill.orderId,
            filledQuoteUsdt: Number(clientDirectFill.filledQuoteUsdt || 0),
            filledBaseQty: Number(clientDirectFill.filledBaseQty || bot.total_base_qty || 0)
          }
        : await executeBinanceSpotOrder({
            userId,
            symbol,
            side: 'SELL',
            baseQuantity: Number(bot.total_base_qty || 0),
            isDemo: isDemoActive,
            fallbackPrice: clientLivePrice
          });

      if (!fill.success) {
        return res.status(400).json({
          success: false,
          requiresClientRelay: Boolean(fill.requiresClientRelay),
          relayOrder: fill.relayOrder || null,
          error: fill.error
        });
      }

      const costBasis = Number(bot.total_position_usdt || 0);
      const netProfit = Math.max(0, fill.filledQuoteUsdt - costBasis);
      const fuelFee20Pct = Number((netProfit * 0.20).toFixed(6));

      if (isDemoActive && netProfit > 0) {
        await pool.query(
          `UPDATE wallets
           SET demo_gas_balance = GREATEST(0, demo_gas_balance - $1),
               demo_profit_usdt = demo_profit_usdt + $2,
               updated_at = NOW()
           WHERE user_id = $3`,
          [fuelFee20Pct, netProfit, userId]
        );
      } else if (!isDemoActive && netProfit > 0) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(
            `UPDATE wallets
             SET gas_balance = GREATEST(0, gas_balance - $1),
                 total_trading_profit = total_trading_profit + $2,
                 updated_at = NOW()
             WHERE user_id = $3`,
            [fuelFee20Pct, netProfit, userId]
          );
          if (fuelFee20Pct > 0) {
            await distributeDifferentialMlm(client, userId, 'GAS_FEE_20PCT', fuelFee20Pct, `${symbol}_MANUAL_SELL_${fill.orderId}`);
          }
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK');
        } finally {
          client.release();
        }
      }

      await pool.query(
        `UPDATE bot_strategies
         SET status = 'PAUSED', current_calls = 0, total_position_usdt = 0, total_base_qty = 0,
             avg_entry_price = 0, highest_price_since_tp = 0, lowest_price_since_drop = 0, updated_at = NOW()
         WHERE user_id = $1 AND symbol = $2`,
        [userId, symbol]
      );

      return res.json({
        success: true,
        message: `Sold ${symbol} for $${fill.filledQuoteUsdt.toFixed(2)} USDT!`
      });
    }

    return res.status(400).json({ success: false, error: 'Unsupported manual action' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Manual order error: ' + err.message });
  }
});

// STRATEGY CIRCLES (V5 / V6 LEADERS ONLY)
app.post('/api/v1/circles', requireAuth, async (req, res) => {
  const userId = req.auth.userId;
  const name = String(req.body.name || '').trim();
  const description = String(req.body.description || '').trim();
  if (!name) return res.status(400).json({ success: false, error: 'Circle name required' });

  const uRes = await pool.query('SELECT rank_level, is_owner_exempt FROM users WHERE id = $1', [userId]);
  const u = uRes.rows[0];
  if (!u || (!u.is_owner_exempt && Number(u.rank_level) < 5)) {
    return res.status(403).json({ success: false, error: 'Only V5 & V6 leaders can create Strategy Circles' });
  }

  await pool.query(
    'INSERT INTO strategy_circles (owner_user_id, name, description) VALUES ($1, $2, $3)',
    [userId, name, description]
  );
  res.json({ success: true });
});

app.post('/api/v1/circles/sync', requireAuth, async (req, res) => {
  const userId = req.auth.userId;
  const circleId = Number(req.body.circleId);
  const synced = Boolean(req.body.synced);
  if (synced) {
    await pool.query('INSERT INTO circle_subscriptions (user_id, circle_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, circleId]);
  } else {
    await pool.query('DELETE FROM circle_subscriptions WHERE user_id = $1 AND circle_id = $2', [userId, circleId]);
  }
  res.json({ success: true });
});

// =========================================================================================
// 10. SERVER BOOTSTRAP
// =========================================================================================
initDatabaseSchema()
  .then(() => {
    startBinanceAllMarketStream();
    setInterval(evaluateActiveDcaBots, 3000);
    setInterval(scanAllUserTrc20SubWallets, 15000);
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`BharatQ Production Engine listening on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Database initialization failed:', err);
    process.exit(1);
  });
