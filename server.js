require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { authenticator } = require('otplib');
const WebSocket = require('ws');
const { Pool } = require('pg');
const cors = require('cors');
const { TronWeb } = require('tronweb');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;
const MASTER_TRC20_ADDRESS = 'TUKdKMmRqpapdSzcQowC2y32cxxHomYEZo';
const OWNER_EMAIL = 'vjrjbhatijodhpur@gmail.com';
const OWNER_MOBILE = '9680714804';
const USDT_TRC20_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const TRONGRID_API_URL = 'https://api.trongrid.io';
const BINANCE_REST_URL = 'https://api.binance.com';
const HOT_WALLET_PRIVATE_KEY = process.env.HOT_WALLET_PRIVATE_KEY || '';
const JWT_SECRET = process.env.JWT_SECRET || 'bharatq-super-secret-jwt-key-change-in-prod';
const KMS_MASTER_KEY = Buffer.from(process.env.KMS_MASTER_KEY_HEX || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'hex');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 50 });

app.get('/api/v1/health', async (req, res) => {
  try {
    const dbCheck = await pool.query('SELECT NOW() AS server_time');
    res.json({ status: 'ONLINE', database: 'CONNECTED', serverTime: dbCheck.rows[0].server_time, masterTrc20Address: MASTER_TRC20_ADDRESS });
  } catch (err) {
    res.status(500).json({ status: 'DEGRADED', error: err.message });
  }
});

app.listen(PORT, () => console.log('BharatQ Production Engine running on port ' + PORT));