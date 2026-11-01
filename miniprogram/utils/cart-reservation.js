function reservationState(reservation, hasItems) {
  const expiresAt = reservation?.expiresAt || '';
  const reserved = !hasItems || (reservation?.reserved === true && Date.parse(expiresAt) > Date.now());
  return { inventoryReserved: reserved, reservationExpiresAt: expiresAt,
    reservationText: !hasItems ? '' : reserved ? '库存已锁定 10 分钟，调整数量后重新计时' : '库存锁定已失效，清单已保留，请重新锁定' };
}
module.exports = { reservationState };
