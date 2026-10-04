const api = require('../../utils/api');
const subscription = require('../../utils/subscription');
Page({
  data: { messages: [], page: 1, hasNext: false, busy: false, subscribing: false },
  onShow() { this.load(1); },
  onReachBottom() { if (this.data.hasNext) this.load(this.data.page + 1); },
  load(page) {
    if (this.data.busy) return;
    this.setData({ busy: true });
    api.request(`/me/messages?page=${page}`).then(data => this.setData({ messages: page === 1 ? data.messages : this.data.messages.concat(data.messages), page, hasNext: data.pagination.hasNext })).catch(error => wx.showToast({ title: error.message, icon: 'none' })).finally(() => this.setData({ busy: false }));
  },
  read(e) {
    const id = Number(e.currentTarget.dataset.id);
    if (!Number.isFinite(id)) return;
    const message = this.data.messages.find(item => Number(item.id) === id);
    api.request(`/me/messages/${id}/read`, { method: 'PATCH' }).then(() => {
      this.setData({ messages: this.data.messages.map(item => Number(item.id) === id ? { ...item, read_at: item.read_at || 'read' } : item) });
      const relatedRoutes = {
        storage_deposit: '/pages/storage/storage',
        storage_withdraw: '/pages/storage/storage',
        storage_expiry: '/pages/storage/storage'
      };
      const url = relatedRoutes[message?.related_type];
      if (url) wx.navigateTo({ url });
    }).catch(error => wx.showToast({ title: error.message || '消息操作失败', icon: 'none' }));
  },
  readAll() { api.request('/me/messages/read-all', { method: 'PATCH' }).then(() => this.setData({ messages: this.data.messages.map(m => ({ ...m, read_at: 'read' })) })).catch(error => wx.showToast({ title: error.message, icon: 'none' })); },
  remove(e) {
    const id = Number(e.currentTarget.dataset.id);
    const message = this.data.messages.find(item => Number(item.id) === id);
    if (!message?.read_at) return wx.showToast({ title: '请先打开消息标记为已读', icon: 'none' });
    wx.showModal({ title: '删除消息', content: '只会从你的消息列表隐藏，商家后台记录仍会保留。', confirmText: '删除', success: result => {
      if (!result.confirm) return;
      api.request(`/me/messages/${id}`, { method: 'DELETE' }).then(() => {
        this.setData({ messages: this.data.messages.filter(item => Number(item.id) !== id) });
        wx.showToast({ title: '消息已删除', icon: 'success' });
      }).catch(error => wx.showToast({ title: error.message, icon: 'none' }));
    } });
  },
  subscribe() {
    if (this.data.subscribing) return;
    this.setData({ subscribing: true });
    subscription.loadTemplates().then(templates => subscription.requestAuthorization(templates))
      .then(() => wx.showToast({ title: '提醒设置已更新', icon: 'success' }))
      .catch(error => wx.showToast({ title: error.message || '授权未完成', icon: 'none' }))
      .finally(() => this.setData({ subscribing: false }));
  }
});
