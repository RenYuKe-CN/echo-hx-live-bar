// Model presets describe hardware, not a different Feie API protocol.
export const defaultPrinterModel = 'fp-v58-h';
export const printerModels = [
  { model: 'fp-v58-h', label: 'FP-V58-H 滴滴（4G）', connection: '4G 全网通', paperWidth: 58, printableWidth: 48, dotsPerLine: 384, columns: 32, hasCutter: false },
  { model: 'custom', label: '其他飞鹅小票机 / 原有配置', connection: '按设备实际联网方式' }
];
export function printerConfiguration(row) {
  if (!row) return null;
  const model = printerModels.find(p => p.model === row.model) || printerModels[1];
  const paperWidth = model.paperWidth ?? row.paper_width ?? 58;
  return { ...row, model: model.model, modelLabel: model.label, connection: model.connection,
    paper_width: paperWidth, has_cutter: model.hasCutter === undefined ? Number(!!row.has_cutter) : Number(model.hasCutter),
    printableWidth: model.printableWidth ?? null, dotsPerLine: model.dotsPerLine ?? null, columns: model.columns ?? (paperWidth === 80 ? 48 : 32) };
}
