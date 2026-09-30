const [major] = process.versions.node.split('.').map(Number);

if (major < 20) {
  console.error(`当前 Node.js 版本为 ${process.versions.node}，Echo HX Live Bar 需要 Node.js 20 或更高版本。请在宝塔 Node 项目中切换 Node 版本后再启动。`);
  process.exit(1);
}

