const api = require('../../utils/api');

Page({
  data: { avatarPath: '', avatarUrl: '', nickname: '', phone: '', busy: false, error: '', profileSaved: false },
  onLoad() {
    Promise.resolve(getApp().apiReady).then(() => api.request('/me')).then(({ user }) => {
      this.setData({ nickname: user.nickname === '微信用户' ? '' : user.nickname, avatarUrl: user.avatarUrl || '', avatarPath: api.imageUrl(user.avatarUrl || ''), phone: user.phone || '', profileSaved: Boolean(user.avatarUrl && user.nickname && user.nickname !== '微信用户') });
    }).catch(error => this.setData({ error: error.message }));
  },
  onChooseAvatar(e) {
    if (e.detail.avatarUrl) this.setData({ avatarPath: e.detail.avatarUrl, avatarUrl: '', profileSaved: false, error: '' });
  },
  onNicknameInput(e) { this.setData({ nickname: e.detail.value, profileSaved: false, error: '' }); },
  saveProfile() {
    if (this.data.busy) return;
    const nickname = this.data.nickname.trim();
    if (!this.data.avatarPath || !nickname || nickname === '微信用户') return this.setData({ error: '请选择头像并填写昵称' });
    this.setData({ busy: true, error: '' });
    const upload = this.data.avatarUrl ? Promise.resolve(this.data.avatarUrl) : api.uploadAvatar(this.data.avatarPath);
    upload.then(avatarUrl => api.request('/me/profile', { method: 'PATCH', data: { nickname, avatarUrl } }).then(({ user }) => {
      this.setData({ avatarUrl: user.avatarUrl || avatarUrl, avatarPath: api.imageUrl(user.avatarUrl || avatarUrl), profileSaved: true, nickname: user.nickname });
      if (user.phone) this.finish();
    })).catch(error => this.setData({ error: error.message || '资料保存失败，请重试' })).finally(() => this.setData({ busy: false }));
  },
  onPhone(e) {
    if (this.data.busy) return;
    if (!e.detail?.code) {
      const detail = e.detail?.errMsg || '';
      return this.setData({ error: detail.includes('deny') || detail.includes('cancel') ? '你没有同意手机号授权，可以点击按钮重新授权' : `未获得手机号授权${detail ? `：${detail}` : '，请点击按钮重试'}` });
    }
    this.setData({ busy: true, error: '' });
    api.request('/me/phone', { method: 'POST', data: { code: e.detail.code } }).then(({ user }) => {
      this.setData({ phone: user.phone || '' });
      this.finish();
    }).catch(error => this.setData({ error: error.message || '手机号绑定失败，请重试' })).finally(() => this.setData({ busy: false }));
  },
  finish() {
    getApp().globalData.profileComplete = true;
    wx.navigateBack();
  }
});
