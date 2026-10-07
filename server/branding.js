import { db } from './db.js';

export function storeName() {
  const configured = db.prepare("SELECT title FROM mini_page_settings WHERE key = 'app_name'").get()?.title;
  return configured?.trim() || db.prepare('SELECT name FROM stores WHERE id = 1').get()?.name?.trim() || '店铺点单';
}
