CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE users (
    uid BIGINT PRIMARY KEY DEFAULT (10000000 + floor(random() * 89999999)::bigint),
    email VARCHAR(255) UNIQUE NOT NULL,
    mobile_number VARCHAR(20) UNIQUE,
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

CREATE INDEX idx_users_sponsor ON users(sponsor_uid);

CREATE TABLE user_wallets (
    uid BIGINT PRIMARY KEY REFERENCES users(uid) ON DELETE CASCADE,
    gas_balance NUMERIC(18, 6) NOT NULL DEFAULT 0.000000 CHECK (gas_balance >= 0),
    commission_balance NUMERIC(18, 6) NOT NULL DEFAULT 0.000000 CHECK (commission_balance >= 0),
    total_trading_profit NUMERIC(18, 6) NOT NULL DEFAULT 0.000000,
    total_tds_deducted NUMERIC(18, 6) NOT NULL DEFAULT 0.000000,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE exchange_api_keys (
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

CREATE TABLE bot_strategies (
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

CREATE TABLE global_dividend_pool (
    pool_date DATE PRIMARY KEY DEFAULT CURRENT_DATE,
    accrued_usdt NUMERIC(18, 6) NOT NULL DEFAULT 0.000000,
    distributed BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE trc20_deposits (
    tx_hash VARCHAR(64) PRIMARY KEY,
    uid BIGINT REFERENCES users(uid),
    from_address VARCHAR(42) NOT NULL,
    to_address VARCHAR(42) NOT NULL,
    amount_usdt NUMERIC(18, 6) NOT NULL,
    block_number BIGINT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'CREDITED',
    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE withdrawal_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    uid BIGINT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
    destination_trc20 VARCHAR(42) NOT NULL,
    amount_usdt NUMERIC(18, 6) NOT NULL CHECK (amount_usdt >= 10),
    network_fee_usdt NUMERIC(18, 6) NOT NULL DEFAULT 1.000000,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    tx_hash VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE ledger_journal (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    debit_account VARCHAR(64) NOT NULL,
    credit_account VARCHAR(64) NOT NULL,
    amount_usdt NUMERIC(18, 6) NOT NULL,
    event_type VARCHAR(32) NOT NULL,
    reference_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);