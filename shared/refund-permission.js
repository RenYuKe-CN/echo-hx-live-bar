export function canProcessRefunds(account) {
  if (account?.role === 'super') return true;
  let permissions = account?.permissions;
  if (typeof permissions === 'string') {
    try { permissions = JSON.parse(permissions); } catch { return false; }
  }
  return Array.isArray(permissions) && permissions.includes('orders') && permissions.includes('refunds');
}
