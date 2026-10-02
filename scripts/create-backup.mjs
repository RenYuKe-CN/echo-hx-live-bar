import { createBackup } from '../server/backup.js';

try {
  const result = await createBackup();
  console.log(`备份完成：${result.name}`);
  console.log(`文件大小：${result.size} bytes`);
} catch (error) {
  console.error(`备份失败：${error.message}`);
  process.exitCode = 1;
}
