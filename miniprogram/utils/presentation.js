function moneyText(value) {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return '—';
  return Number(value).toFixed(2);
}

function iconPath(name, tone = 'green') {
  const names = ['gift', 'bottle', 'wallet', 'receipt', 'star', 'glass', 'card', 'bag', 'ticket', 'bell', 'crown', 'settings', 'table', 'info', 'beer', 'plate', 'user'];
  return `/assets/icons/${names.includes(name) ? name : 'card'}-${tone}.png`;
}

function productIcon(product) {
  const category = product.category || '';
  if (/啤酒/.test(category)) return iconPath('beer', 'muted');
  if (/小吃|餐|食品/.test(category)) return iconPath('plate', 'muted');
  if (/套餐|洋酒|威士忌/.test(category)) return iconPath('bottle', 'muted');
  return iconPath('glass', 'muted');
}

module.exports = { moneyText, iconPath, productIcon };
