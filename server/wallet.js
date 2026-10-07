export function walletBalance(database, userId) {
  const wallet = database.prepare(`SELECT stored_cents, bonus_cents, stored_reserved_cents, bonus_reserved_cents
    FROM wallet_accounts WHERE user_id = ?`).get(userId)
    || { stored_cents: 0, bonus_cents: 0, stored_reserved_cents: 0, bonus_reserved_cents: 0 };
  return {
    ...wallet,
    availableStored: Math.max(0, wallet.stored_cents - wallet.stored_reserved_cents),
    availableBonus: Math.max(0, wallet.bonus_cents - wallet.bonus_reserved_cents)
  };
}

export function debitAvailableWallet(database, userId, stored, bonus) {
  const result = database.prepare(`UPDATE wallet_accounts
    SET stored_cents = stored_cents - ?, bonus_cents = bonus_cents - ?, updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ? AND stored_cents - stored_reserved_cents >= ? AND bonus_cents - bonus_reserved_cents >= ?`)
    .run(stored, bonus, userId, stored, bonus);
  if (!result.changes) throw new Error('可用余额不足，请刷新后重试');
}

export function debitReservedWallet(database, userId, stored, bonus) {
  const result = database.prepare(`UPDATE wallet_accounts
    SET stored_cents = stored_cents - ?, bonus_cents = bonus_cents - ?,
      stored_reserved_cents = stored_reserved_cents - ?, bonus_reserved_cents = bonus_reserved_cents - ?, updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ? AND stored_reserved_cents >= ? AND bonus_reserved_cents >= ?
      AND stored_cents >= stored_reserved_cents AND bonus_cents >= bonus_reserved_cents`)
    .run(stored, bonus, stored, bonus, userId, stored, bonus);
  if (!result.changes) throw new Error('余额或冻结金额不一致，请联系管理员核对');
}
