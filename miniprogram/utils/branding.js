const FALLBACK_NAME = '店铺点单';
const FALLBACK_TITLE = '今晚喝点什么？';
const STORAGE_KEY = 'echoMiniPageSettings';

function readSettings(page = {}) {
  const entries = Array.isArray(page.entries) ? page.entries : [];
  const values = Object.fromEntries(entries.map(entry => [entry.key, String(entry.title || '').trim()]));
  let cached = {};
  try { cached = wx.getStorageSync(STORAGE_KEY) || {}; } catch {}
  return { appName: values.app_name || cached.appName || FALLBACK_NAME, homeTitle: values.home_title || cached.homeTitle || FALLBACK_TITLE };
}

function saveSettings(page) {
  const settings = readSettings(page);
  try { wx.setStorageSync(STORAGE_KEY, settings); } catch {}
  return settings;
}

function applySettings(page, configuration) {
  const settings = saveSettings(configuration);
  page.setData(settings);
  wx.setNavigationBarTitle({ title: settings.appName });
  return settings;
}

module.exports = { readSettings, saveSettings, applySettings };
