// ... existing code ...
// Save & Start Quantitative Strategy (Strictly Requires $120 VIP Activation + Min $20 Fuel Gas or Owner Exemption)
app.post('/api/v1/bot/strategy', requireAuth, async (req, res) => {
  try {
    const uCheck = await pool.query(
      `SELECT u.is_activated, u.is_owner_exempt, COALESCE(w.gas_balance, 0) AS gas_balance
       FROM users u
       LEFT JOIN user_wallets w ON u.uid = w.uid
       WHERE u.uid = $1 LIMIT 1`,
      [req.user.uid]
    );
    const uRow = uCheck.rows[0];
    if (!uRow || (!uRow.is_activated && !uRow.is_owner_exempt)) {
      return res.status(403).json({ success: false, error: 'VIP License ($120/year) required before starting the bot.' });
    }
    if (!uRow.is_owner_exempt && Number(uRow.gas_balance) < 20.0) {
      return res.status(403).json({
        success: false,
        error: 'Minimum 20.00 USDT Fuel Gas balance required in your Fuel Wallet before starting trades.'
      });
    }
    const {
      symbol,
// ... existing code ...
// Manual Buy / Sell Position Action (Strictly Requires $120 VIP Activation + Min $20 Fuel Gas or Owner Exemption)
app.post('/api/v1/bot/manual-action', requireAuth, async (req, res) => {
  try {
    const uCheck = await pool.query(
      `SELECT u.is_activated, u.is_owner_exempt, COALESCE(w.gas_balance, 0) AS gas_balance
       FROM users u
       LEFT JOIN user_wallets w ON u.uid = w.uid
       WHERE u.uid = $1 LIMIT 1`,
      [req.user.uid]
    );
    const uRow = uCheck.rows[0];
    if (!uRow || (!uRow.is_activated && !uRow.is_owner_exempt)) {
      return res.status(403).json({ success: false, error: 'VIP License ($120/year) required to execute bot orders.' });
    }
    if (!uRow.is_owner_exempt && Number(uRow.gas_balance) < 20.0) {
      return res.status(403).json({
        success: false,
        error: 'Minimum 20.00 USDT Fuel Gas balance required in your Fuel Wallet before executing orders.'
      });
    }
    const { symbol, action, extraUsdt } = req.body;
// ... existing code ...
// 24/7 Cloud Quantitative DCA Engine (Strictly Runs Only for $120 VIP Active Users with >= $20 Fuel Gas & V6 Owner)
async function evaluateActiveDcaBots() {
  dcaCyclesProcessed += 1;
  try {
    // Automatic Low-Fuel Pause Protection: Pause active cycles if non-owner Fuel Gas drops below 20.00 USDT
    await pool.query(`
      UPDATE bot_strategies b
      SET status = 'PAUSED', updated_at = NOW()
      FROM users u
      LEFT JOIN user_wallets w ON u.uid = w.uid
      WHERE b.uid = u.uid
        AND b.status IN ('CYCLING', 'Cycling')
        AND u.is_owner_exempt = FALSE
        AND COALESCE(w.gas_balance, 0) < 20.00
    `);

    const activeBots = await pool.query(`
      SELECT b.* FROM bot_strategies b
      INNER JOIN users u ON b.uid = u.uid
      LEFT JOIN user_wallets w ON b.uid = w.uid
      WHERE b.status IN ('CYCLING', 'Cycling')
        AND (u.is_activated = TRUE OR u.is_owner_exempt = TRUE)
        AND (u.is_owner_exempt = TRUE OR COALESCE(w.gas_balance, 0) >= 20.00)
    `);
    for (const bot of activeBots.rows) {
// ... existing code ...
