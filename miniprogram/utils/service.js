const api = require('./api');
const labels = { waiting: '等待响应', claimed: '服务员处理中', completed: '已处理' };
const initialData = { serviceVisible: false, serviceType: 'help', serviceNote: '', serviceBusy: false, serviceLoadError: '', serviceRequests: [], servicePendingCount: 0, serviceTypes: [{ key: 'help', label: '呼叫服务员' }, { key: 'tissue', label: '需要纸巾' }, { key: 'cleanup', label: '收拾桌面' }, { key: 'remind', label: '催单' }, { key: 'other', label: '其他帮助' }] };
function requestId() { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.floor(Math.random() * 16); return (c === 'x' ? r : (r & 3) | 8).toString(16); }); }
function context() { const data = getApp().globalData; return { sessionId: data.sessionId, tableVersion: data.tableVersion }; }
function current(snapshot) { const data = context(); return snapshot.sessionId === data.sessionId && snapshot.tableVersion === data.tableVersion; }
const methods = {
  openService() {
    if (!getApp().globalData.hasScannedTable) return wx.showToast({ title: '请先用微信扫描桌台码', icon: 'none' });
    if (!context().sessionId) return wx.showToast({ title: '桌台尚未连接，请加载完成后重试', icon: 'none' });
    this.setData({ serviceVisible: true, serviceLoadError: '' }); this.refreshServices();
  },
  closeService() { if (!this.data.serviceBusy) this.setData({ serviceVisible: false }); },
  selectServiceType(event) { this.setData({ serviceType: event.currentTarget.dataset.type }); },
  onServiceNote(event) { this.setData({ serviceNote: event.detail.value }); },
  async refreshServices() {
    const snapshot = context(); if (!getApp().globalData.hasScannedTable || !snapshot.sessionId) return;
    const version = this.serviceReadVersion = (this.serviceReadVersion || 0) + 1;
    try {
      const data = await api.request(`/sessions/${snapshot.sessionId}/services`, { timeout: 10000 });
      if (!current(snapshot) || version !== this.serviceReadVersion) return;
      const requests = data.requests.map(item => ({ ...item, statusLabel: labels[item.status], notesText: (item.notes || []).map(note => note.content).join('\n') }));
      this.setData({ serviceRequests: requests, servicePendingCount: requests.filter(item => item.status !== 'completed').length, serviceLoadError: '', serviceTypes: Object.entries(data.types).map(([key,label]) => ({key,label})) });
    } catch (error) { if (current(snapshot) && version === this.serviceReadVersion) this.setData({ serviceLoadError: error.message || '需求状态暂时无法读取，请重试' }); }
  },
  async submitService() {
    if (this.data.serviceBusy) return;
    const snapshot = context(), note = String(this.data.serviceNote || '').trim(), type = this.data.serviceType;
    if (!getApp().globalData.hasScannedTable || !snapshot.sessionId) return wx.showToast({ title: '请先扫描桌台码', icon: 'none' });
    if (type === 'other' && !note) return wx.showToast({ title: '请填写具体服务需求', icon: 'none' });
    const fingerprint = JSON.stringify([snapshot.sessionId, type, note]);
    if (this.serviceCommand?.fingerprint !== fingerprint) this.serviceCommand = { fingerprint, requestId: requestId() };
    const command = this.serviceCommand;
    this.setData({ serviceBusy: true, serviceLoadError: '' });
    try {
      const result = await api.request(`/sessions/${snapshot.sessionId}/services`, { method: 'POST', timeout: 10000, data: { type, note, requestId: command.requestId } });
      if (!current(snapshot)) return;
      this.serviceCommand = null; this.setData({ serviceNote: '' });
      wx.showToast({ title: result.merged || result.repeated ? '已通知，本桌需求已合并' : '已通知服务员', icon: 'none' });
      await this.refreshServices();
    } catch (error) { if (current(snapshot)) this.setData({ serviceLoadError: (error.message || '提交状态未确认') + '，可重试，重复提交不会重复派单。' }); }
    finally { if (current(snapshot)) this.setData({ serviceBusy: false }); }
  },
  startServicePolling() { this.stopServicePolling(); this.serviceTimer = setInterval(() => this.refreshServices(), 5000); },
  stopServicePolling() { if (this.serviceTimer) clearInterval(this.serviceTimer); this.serviceTimer = null; }
};
module.exports = { initialData, methods };
