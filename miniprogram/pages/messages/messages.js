const api = require('../../utils/api');
Page({
  data: { messages: [], page: 1, hasNext: false, busy: false, subscribing: false },
  onShow() { this.load(1); },
  onReachBottom() { if (this.data.hasNext) this.load(this.data.page + 1); },
  load(page) {
    if (this.data.busy) return;
    this.setData({ busy: true });
    api.request(`/me/messages?page=${page}`).then(data => this.setData({ messages: page === 1 ? data.messages : this.data.messages.concat(data.messages), page, hasNext: data.pagination.hasNext })).catch(error => wx.showToast({ title: error.message, icon: 'none' })).finally(() => this.setData({ busy: false }));
  },
  read(e) { const id = e.currentTarget.dataset.id; api.request(`/me/messages/${id}/read`, { method: 'PATCH' }).then(() => this.setData({ messages: this.data.messages.map(m => m.id === id ? { ...m, read_at: 'read' } : m) })); },
  readAll() { api.request('/me/messages/read-all', { method: 'PATCH' }).then(() => this.setData({ messages: this.data.messages.map(m => ({ ...m, read_at: 'read' })) })).catch(error => wx.showToast({ title: error.message, icon: 'none' })); },
  subscribe() {
    if (this.data.subscribing) return;
    this.setData({ subscribing: true });
    api.request('/message-subscription-templates').then(({ templates }) => {
      const usable = (templates || []).filter(item => item.wechatTemplateId);
      if (!usable.length) throw new Error('商家暂未配置微信订阅消息模板');
      return new Promise((resolve, reject) => wx.requestSubscribeMessage({
        tmplIds: usable.map(item => item.wechatTemplateId),
        success: result => resolve({ result, templates: usable }),
        fail: reject
      }));
    }).then(({ result, templates }) => api.request('/me/subscription-authorizations', {
      method: 'POST',
      data: { authorizations: templates.map(item => ({ templateKey: item.templateKey, wechatTemplateId: item.wechatTemplateId, status: result[item.wechatTemplateId] || 'reject' })) }
    })).then(() => wx.showToast({ title: '提醒设置已更新', icon: 'success' })).catch(error => wx.showToast({ title: error.message || '授权未完成', icon: 'none' })).finally(() => this.setData({ subscribing: false }));
  }
});
