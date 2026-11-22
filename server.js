// ... existing code ...
      commission_balance NUMERIC(18, 6) NOT NULL DEFAULT 0.000000 CHECK (commission_balance >= 0),
      total_trading_profit NUMERIC(18, 6) NOT NULL DEFAULT 0.000000,
      total_tds_deducted NUMERIC(18, 6) NOT NULL DEFAULT 0.000000,
      demo_mode_active BOOLEAN NOT NULL DEFAULT FALSE,
      demo_usdt_balance NUMERIC(18, 6) NOT NULL DEFAULT 0.000000,
      demo_gas_balance NUMERIC(18, 6) NOT NULL DEFAULT 0.000000,
      demo_profit_usdt NUMERIC(18, 6) NOT NULL DEFAULT 0.000000,
      demo_expires_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE user_wallets ADD COLUMN IF NOT EXISTS demo_mode_active BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE user_wallets ADD COLUMN IF NOT EXISTS demo_usdt_balance NUMERIC(18, 6) NOT NULL DEFAULT 0.000000;
    ALTER TABLE user_wallets ADD COLUMN IF NOT EXISTS demo_gas_balance NUMERIC(18, 6) NOT NULL DEFAULT 0.000000;
    ALTER TABLE user_wallets ADD COLUMN IF NOT EXISTS demo_profit_usdt NUMERIC(18, 6) NOT NULL DEFAULT 0.000000;
    ALTER TABLE user_wallets ADD COLUMN IF NOT EXISTS demo_expires_at TIMESTAMPTZ;
    CREATE TABLE IF NOT EXISTS exchange_api_keys (
// ... existing code ...
    ALTER TABLE bot_strategies ADD COLUMN IF NOT EXISTS circuit_breaker_pct NUMERIC(5, 2) NOT NULL DEFAULT 18.00;
    ALTER TABLE bot_strategies ADD COLUMN IF NOT EXISTS trailing_floor_pct NUMERIC(5, 2) NOT NULL DEFAULT 0.90;
    ALTER TABLE bot_strategies ADD COLUMN IF NOT EXISTS dip_trough_price NUMERIC(18, 8) NOT NULL DEFAULT 0.00000000;
    ALTER TABLE bot_strategies ADD COLUMN IF NOT EXISTS is_demo_trade BOOLEAN NOT NULL DEFAULT FALSE;

    CREATE TABLE IF NOT EXISTS global_dividend_pool (
// ... existing code ...
// Execute a real Spot market order on user's bound Binance account (or 24H $10,000 Paper Sandbox when demo mode is active)
async function executeBinanceSpotOrder(uid, rawSymbol, side, quoteOrderQtyUsdt, exactSellBaseQty = null) {
  try {
    const demoCheck = await pool.query(
      'SELECT demo_mode_active, demo_usdt_balance, demo_expires_at FROM user_wallets WHERE uid = $1 LIMIT 1',
      [uid]
    );
    const dRow = demoCheck.rows[0];
    if (dRow && dRow.demo_mode_active && dRow.demo_expires_at && new Date(dRow.demo_expires_at) > new Date()) {
      const curPrice = await getOrFetchLiveSymbolPrice(rawSymbol);
      if (!curPrice || curPrice <= 0) {
        return { executedOnExchange: false, friendlyError: 'Waiting for live market price tick...' };
      }
      if (side === 'BUY') {
        const spendUsdt = Number(quoteOrderQtyUsdt);
        if (Number(dRow.demo_usdt_balance) < spendUsdt) {
          return {
            executedOnExchange: false,
            friendlyError: `Insufficient 24H Demo Spot Balance ($${Number(dRow.demo_usdt_balance).toFixed(2)} USDT left)`
          };
        }
        const boughtQty = spendUsdt / curPrice;
        await pool.query(
          'UPDATE user_wallets SET demo_usdt_balance = demo_usdt_balance - $1, updated_at = NOW() WHERE uid = $2',
          [spendUsdt, uid]
        );
        return {
          executedOnExchange: true,
          isDemoFill: true,
          filledQuoteUsdt: spendUsdt,
          filledBaseQty: boughtQty,
          details: { orderId: `DEMO_${Date.now()}`, price: curPrice }
        };
      } else {
        const sellQty = exactSellBaseQty && Number(exactSellBaseQty) > 0
          ? Number(exactSellBaseQty)
          : (Number(quoteOrderQtyUsdt) / curPrice);
        const receivedUsdt = sellQty * curPrice;
        await pool.query(
          'UPDATE user_wallets SET demo_usdt_balance = demo_usdt_balance + $1, updated_at = NOW() WHERE uid = $2',
          [receivedUsdt, uid]
        );
        return {
          executedOnExchange: true,
          isDemoFill: true,
          filledQuoteUsdt: receivedUsdt,
          filledBaseQty: sellQty,
          details: { orderId: `DEMO_${Date.now()}`, price: curPrice }
        };
      }
    }

    const keyRes = await pool.query(
      "SELECT * FROM exchange_api_keys WHERE uid = $1 AND exchange_name = 'BINANCE' AND is_valid = TRUE LIMIT 1",
// ... existing code ...
    res.json({
      success: true,
      user: userRow,
      personalDepositAddress,
      wallet: wRes.rows[0] || { gas_balance: 0, commission_balance: 0, total_trading_profit: 0, demo_mode_active: false, demo_usdt_balance: 0, demo_gas_balance: 0, demo_profit_usdt: 0 },
      todayProfit: Number(todayProfitRes.rows[0]?.today_usdt || 0),
      boundExchanges: keysRes.rows,
// ... existing code ...
// Start or Stop 24-Hour $10,000 Paper-Trading Sandbox Mode
app.post('/api/v1/demo/toggle', requireAuth, async (req, res) => {
  try {
    const enable = req.body.enable !== false;
    if (enable) {
      const upd = await pool.query(
        `UPDATE user_wallets SET
           demo_mode_active = TRUE,
           demo_usdt_balance = 10000.000000,
           demo_gas_balance = 500.000000,
           demo_profit_usdt = 0.000000,
           demo_expires_at = NOW() + INTERVAL '24 hours',
           updated_at = NOW()
         WHERE uid = $1
         RETURNING demo_mode_active, demo_usdt_balance, demo_gas_balance, demo_profit_usdt, demo_expires_at`,
        [req.user.uid]
      );
      return res.json({ success: true, demo: upd.rows[0] });
    } else {
      await pool.query(
        `UPDATE bot_strategies SET
           status = 'PAUSED', current_calls = 0, total_position_usdt = 0, total_base_qty = 0,
           avg_entry_price = 0, sub_bin_position_usdt = 0, sub_bin_base_qty = 0, is_demo_trade = FALSE
         WHERE uid = $1 AND is_demo_trade = TRUE`,
        [req.user.uid]
      );
      const upd = await pool.query(
        `UPDATE user_wallets SET
           demo_mode_active = FALSE,
           demo_usdt_balance = 0,
           demo_gas_balance = 0,
           demo_expires_at = NULL,
           updated_at = NOW()
         WHERE uid = $1
         RETURNING demo_mode_active, demo_usdt_balance, demo_gas_balance, demo_profit_usdt, demo_expires_at`,
        [req.user.uid]
      );
      return res.json({ success: true, demo: upd.rows[0] });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Save & Start Quantitative Strategy (Supports Real Binance Spot OR 24H $10,000 Paper Sandbox)
app.post('/api/v1/bot/strategy', requireAuth, async (req, res) => {
  try {
    const uCheck = await pool.query(
      `SELECT u.is_activated, u.is_owner_exempt,
              COALESCE(w.gas_balance, 0) AS gas_balance,
              COALESCE(w.demo_mode_active, FALSE) AS demo_mode_active,
              COALESCE(w.demo_usdt_balance, 0) AS demo_usdt_balance,
              COALESCE(w.demo_gas_balance, 0) AS demo_gas_balance,
              w.demo_expires_at
       FROM users u
       LEFT JOIN user_wallets w ON u.uid = w.uid
       WHERE u.uid = $1 LIMIT 1`,
      [req.user.uid]
    );
    const uRow = uCheck.rows[0];
    const isDemoActive = Boolean(uRow && uRow.demo_mode_active && uRow.demo_expires_at && new Date(uRow.demo_expires_at) > new Date());

    if (!isDemoActive) {
      if (!uRow || (!uRow.is_activated && !uRow.is_owner_exempt)) {
        return res.status(403).json({ success: false, error: 'VIP License ($120/year) required — or activate 24H $10,000 Free Test Mode on Home!' });
      }
      if (!uRow.is_owner_exempt && Number(uRow.gas_balance) < 20.0) {
        return res.status(403).json({
          success: false,
          error: 'Minimum 20.00 USDT Fuel Gas balance required in your Fuel Wallet before starting trades.'
        });
      }
    }
    const {
// ... existing code ...
    if (desiredStatus === 'CYCLING') {
      if (isDemoActive) {
        const demoSpotUsdt = Number(uRow.demo_usdt_balance || 0);
        if (!hasOpenPosition && demoSpotUsdt < effectiveFirstBuy) {
          return res.status(400).json({
            success: false,
            error: `Insufficient 24H Demo USDT ($${demoSpotUsdt.toFixed(2)} left, $${effectiveFirstBuy.toFixed(2)} required).`
          });
        }
        if (!hasOpenPosition) {
          const firstOrder = await executeBinanceSpotOrder(req.user.uid, rawSym, 'BUY', effectiveFirstBuy);
          if (!firstOrder.executedOnExchange) {
            return res.status(400).json({ success: false, error: firstOrder.friendlyError || 'Demo order failed' });
          }
          initialPosUsdt = firstOrder.filledQuoteUsdt;
          initialBaseQty = firstOrder.filledBaseQty;
          initialEntryPrice = initialPosUsdt / initialBaseQty;
        }
      } else {
        const boundKeyRes = await pool.query(
          "SELECT api_key, encrypted_secret, iv_hex, auth_tag_hex FROM exchange_api_keys WHERE uid = $1 AND exchange_name = 'BINANCE' AND is_valid = TRUE LIMIT 1",
          [req.user.uid]
        );
        if (!boundKeyRes.rows.length) {
          return res.status(400).json({
            success: false,
            error: 'No valid Binance Spot API key bound. Bind your Binance API first (or tap 24H $10,000 Demo).'
          });
        }

        const kRow = boundKeyRes.rows[0];
        const plainSecret = decryptApiSecret(kRow.encrypted_secret, kRow.iv_hex, kRow.auth_tag_hex);
        const liveAccountCheck = await verifyExchangeCredentialsLive('BINANCE', kRow.api_key, plainSecret);
        if (!liveAccountCheck.valid) {
          return res.status(400).json({
            success: false,
            error: liveAccountCheck.error || 'Binance API verification failed.'
          });
        }

        const liveSpotUsdt = Number(liveAccountCheck.spotUsdtBalance || 0);
        if (!hasOpenPosition && liveSpotUsdt < effectiveFirstBuy) {
          return res.status(400).json({
            success: false,
            spotUsdtBalance: liveSpotUsdt,
            error: `Insufficient Binance Spot Balance ($${liveSpotUsdt.toFixed(2)} USDT available, $${effectiveFirstBuy.toFixed(2)} USDT required). Add USDT to your Binance Spot Wallet first.`
          });
        }

        if (!hasOpenPosition) {
          const firstOrder = await executeBinanceSpotOrder(req.user.uid, rawSym, 'BUY', effectiveFirstBuy);
          if (!firstOrder.executedOnExchange) {
            const binanceReason = firstOrder.details?.msg || firstOrder.error || firstOrder.friendlyError || 'Exchange rejected initial Spot BUY order';
            const isSharedIpRateLimit = String(binanceReason).includes('-1003') || String(binanceReason).toLowerCase().includes('rate-limit');
            if (isSharedIpRateLimit) {
              return res.status(200).json({
                success: false,
                requiresClientRelay: true,
                relayOrder: {
                  side: 'BUY',
                  rawSymbol: rawSym,
                  quoteOrderQty: effectiveFirstBuy.toFixed(2),
                  apiKey: kRow.api_key,
                  apiSecret: plainSecret
                },
                error: 'Shared server IP cooling down — switching to Direct Device Spot Execution...'
              });
            }
            return res.status(400).json({
              success: false,
              spotUsdtBalance: liveSpotUsdt,
              error: `Binance Spot Order Failed: ${binanceReason} (Spot Balance: $${liveSpotUsdt.toFixed(2)} USDT).`
            });
          }
          initialPosUsdt = firstOrder.filledQuoteUsdt && firstOrder.filledQuoteUsdt > 0 ? firstOrder.filledQuoteUsdt : effectiveFirstBuy;
          initialBaseQty = firstOrder.filledBaseQty && firstOrder.filledBaseQty > 0 ? firstOrder.filledBaseQty : (initialPosUsdt / curPrice);
          initialEntryPrice = initialPosUsdt / initialBaseQty;
        }
      }
    }

    await pool.query(
      `INSERT INTO bot_strategies (
         uid, symbol, status, strategy_mode, cycle_type, first_buy_usdt, open_position_doubling,
         margin_call_limit, margin_drop_pct, take_profit_pct, callback_pct, buy_in_callback_pct, sub_bin_tp_pct,
         ai_rsi_filter, ai_dynamic_tp, auto_compound, circuit_breaker_pct, trailing_floor_pct,
         layer_schedule, total_position_usdt, total_base_qty, avg_entry_price, peak_price_since_tp, is_demo_trade, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $22, $23, NOW())
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
         is_demo_trade = EXCLUDED.is_demo_trade,
         avg_entry_price = CASE WHEN bot_strategies.avg_entry_price = 0 THEN EXCLUDED.avg_entry_price ELSE bot_strategies.avg_entry_price END,
         total_position_usdt = CASE WHEN bot_strategies.total_position_usdt = 0 THEN EXCLUDED.total_position_usdt ELSE bot_strategies.total_position_usdt END,
         total_base_qty = CASE WHEN bot_strategies.total_base_qty = 0 THEN EXCLUDED.total_base_qty ELSE bot_strategies.total_base_qty END,
         updated_at = NOW()`,
      [
        req.user.uid,
        symbol,
        desiredStatus,
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
        initialPosUsdt,
        initialBaseQty,
        initialEntryPrice,
        isDemoActive
      ]
    );
    res.json({ success: true, symbol, livePrice: initialEntryPrice, isDemoActive });
  } catch (err) {
// ... existing code ...
// Manual Buy / Sell Position Action (Supports Real Binance Spot OR 24H $10,000 Paper Sandbox)
app.post('/api/v1/bot/manual-action', requireAuth, async (req, res) => {
  try {
    const uCheck = await pool.query(
      `SELECT u.is_activated, u.is_owner_exempt,
              COALESCE(w.gas_balance, 0) AS gas_balance,
              COALESCE(w.demo_mode_active, FALSE) AS demo_mode_active,
              w.demo_expires_at
       FROM users u
       LEFT JOIN user_wallets w ON u.uid = w.uid
       WHERE u.uid = $1 LIMIT 1`,
      [req.user.uid]
    );
    const uRow = uCheck.rows[0];
    const isDemoActive = Boolean(uRow && uRow.demo_mode_active && uRow.demo_expires_at && new Date(uRow.demo_expires_at) > new Date());
    if (!isDemoActive) {
      if (!uRow || (!uRow.is_activated && !uRow.is_owner_exempt)) {
        return res.status(403).json({ success: false, error: 'VIP License ($120/year) required to execute bot orders.' });
      }
      if (!uRow.is_owner_exempt && Number(uRow.gas_balance) < 20.0) {
        return res.status(403).json({
          success: false,
          error: 'Minimum 20.00 USDT Fuel Gas balance required in your Fuel Wallet before executing orders.'
        });
      }
    }
    const { symbol, action, extraUsdt, clientDirectFill } = req.body;
// ... existing code ...
      if (realizedPnl > 0) {
        if (isDemoActive) {
          await pool.query(
            'UPDATE user_wallets SET demo_profit_usdt = demo_profit_usdt + $1, updated_at = NOW() WHERE uid = $2',
            [realizedPnl, req.user.uid]
          );
        } else {
          await pool.query(
            'UPDATE user_wallets SET total_trading_profit = total_trading_profit + $1, updated_at = NOW() WHERE uid = $2',
            [realizedPnl, req.user.uid]
          );
        }
      }
      return res.json({
// ... existing code ...
// 24/7 Cloud Quantitative DCA Engine (Runs Live VIP Bots + Active 24H $10,000 Paper Sandbox Bots)
async function evaluateActiveDcaBots() {
  dcaCyclesProcessed += 1;
  try {
    // Auto-expire finished 24-hour demo sandboxes
    const expiredDemoUsers = await pool.query(`
      UPDATE user_wallets
      SET demo_mode_active = FALSE, demo_usdt_balance = 0, demo_gas_balance = 0, demo_expires_at = NULL, updated_at = NOW()
      WHERE demo_mode_active = TRUE AND demo_expires_at <= NOW()
      RETURNING uid
    `);
    for (const expRow of expiredDemoUsers.rows) {
      await pool.query(
        `UPDATE bot_strategies SET
           status = 'PAUSED', current_calls = 0, total_position_usdt = 0, total_base_qty = 0,
           avg_entry_price = 0, sub_bin_position_usdt = 0, sub_bin_base_qty = 0, is_demo_trade = FALSE
         WHERE uid = $1 AND is_demo_trade = TRUE`,
        [expRow.uid]
      );
    }

    await pool.query(`
      UPDATE bot_strategies b
      SET status = 'PAUSED', updated_at = NOW()
      FROM users u
      LEFT JOIN user_wallets w ON u.uid = w.uid
      WHERE b.uid = u.uid
        AND b.status IN ('CYCLING', 'Cycling')
        AND b.is_demo_trade = FALSE
        AND u.is_owner_exempt = FALSE
        AND COALESCE(w.gas_balance, 0) < 20.00
    `);

    const activeBots = await pool.query(`
      SELECT b.*, COALESCE(w.demo_mode_active, FALSE) AS wallet_demo_active, w.demo_expires_at
      FROM bot_strategies b
      INNER JOIN users u ON b.uid = u.uid
      LEFT JOIN user_wallets w ON b.uid = w.uid
      WHERE b.status IN ('CYCLING', 'Cycling')
        AND (
          (b.is_demo_trade = TRUE AND w.demo_mode_active = TRUE AND w.demo_expires_at > NOW() AND COALESCE(w.demo_gas_balance, 0) >= 1.00)
          OR
          (b.is_demo_trade = FALSE AND (u.is_activated = TRUE OR u.is_owner_exempt = TRUE) AND (u.is_owner_exempt = TRUE OR COALESCE(w.gas_balance, 0) >= 20.00))
        )
    `);
    for (const bot of activeBots.rows) {
      const isBotDemo = Boolean(bot.is_demo_trade && bot.wallet_demo_active);
// ... existing code ...
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            if (isBotDemo) {
              if (subProfit > 0) {
                await client.query(
                  'UPDATE user_wallets SET demo_gas_balance = GREATEST(0, demo_gas_balance - $1), demo_profit_usdt = demo_profit_usdt + $2, updated_at = NOW() WHERE uid = $3',
                  [subGasFee, subProfit, bot.uid]
                );
              }
            } else {
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
            }
            await client.query(
              `UPDATE bot_strategies SET
// ... existing code ...
            if (isBotDemo || isOwner || (wRes.rows.length && Number(wRes.rows[0].gas_balance) >= gasFee20Pct)) {
              if (isBotDemo) {
                if (profitUsdt > 0) {
                  await client.query(
                    'UPDATE user_wallets SET demo_gas_balance = GREATEST(0, demo_gas_balance - $1), demo_profit_usdt = demo_profit_usdt + $2, updated_at = NOW() WHERE uid = $3',
                    [gasFee20Pct, profitUsdt, bot.uid]
                  );
                }
              } else if (!isOwner && profitUsdt > 0) {
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
              const netCycleGain = Math.max(0, profitUsdt - (!isBotDemo && isOwner ? 0 : gasFee20Pct));
              const baseFirstBuy = Number(bot.first_buy_usdt) || 20;
// ... existing code ...
