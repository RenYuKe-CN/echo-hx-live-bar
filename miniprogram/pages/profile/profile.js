const api = require('../../utils/api');

Page({
  data: { avatarPath: '', avatarUrl: '', nickname: '', phone: '', birthdayType: '', birthdayTypeIndex: 0, birthdayTypes: ['不设置', '阳历', '农历'], birthdayDate: '', birthdayLocked: false, solarBirthday: '2000-01-01', lunarMonth: '1', lunarDay: '1', lunarMonthIndex: 0, lunarDayIndex: 0, lunarMonths: Array.from({ length: 12 }, (_, index) => String(index + 1)), lunarDays: Array.from({ length: 30 }, (_, index) => String(index + 1)), busy: false, error: '', profileSaved: false },
  onLoad() {
    Promise.resolve(getApp().apiReady).then(() => api.request('/me')).then(({ user }) => {
      const birthdayType = user.birthdayType || '';
      const birthdayDate = user.birthdayDate || '';
      const [birthdayMonth = '01', birthdayDay = '01'] = birthdayDate.split('-');
      this.setData({ nickname: user.nickname === '微信用户' ? '' : user.nickname, avatarUrl: user.avatarUrl || '', avatarPath: api.imageUrl(user.avatarUrl || ''), phone: user.phone || '', birthdayType, birthdayTypeIndex: ['', 'solar', 'lunar'].indexOf(birthdayType), birthdayDate, birthdayLocked: Boolean(birthdayType && birthdayDate), solarBirthday: `2000-${birthdayMonth}-${birthdayDay}`, lunarMonth: String(Number(birthdayMonth) || 1), lunarDay: String(Number(birthdayDay) || 1), lunarMonthIndex: (Number(birthdayMonth) || 1) - 1, lunarDayIndex: (Number(birthdayDay) || 1) - 1, profileSaved: Boolean(user.avatarUrl && user.nickname && user.nickname !== '微信用户') });
    }).catch(error => this.setData({ error: error.message }));
  },
  onChooseAvatar(e) {
    if (e.detail.avatarUrl) this.setData({ avatarPath: e.detail.avatarUrl, avatarUrl: '', profileSaved: false, error: '' });
  },
  onNicknameInput(e) { this.setData({ nickname: e.detail.value, profileSaved: false, error: '' }); },
  onBirthdayTypeChange(e) {
    const birthdayTypeIndex = Number(e.detail.value);
    const birthdayType = ['', 'solar', 'lunar'][birthdayTypeIndex];
    const birthdayDate = birthdayType === 'solar' ? this.data.solarBirthday.slice(5) : birthdayType === 'lunar' ? `${String(this.data.lunarMonth).padStart(2, '0')}-${String(this.data.lunarDay).padStart(2, '0')}` : '';
    this.setData({ birthdayTypeIndex, birthdayType, birthdayDate, error: '' });
  },
  onSolarBirthdayChange(e) {
    const birthdayDate = e.detail.value.slice(5);
    this.setData({ solarBirthday: e.detail.value, birthdayDate, error: '' });
  },
  onLunarMonthChange(e) {
    const lunarMonthIndex = Number(e.detail.value);
    const lunarMonth = this.data.lunarMonths[lunarMonthIndex];
    this.setData({ lunarMonth, lunarMonthIndex, birthdayDate: `${String(lunarMonth).padStart(2, '0')}-${String(this.data.lunarDay).padStart(2, '0')}`, error: '' });
  },
  onLunarDayChange(e) {
    const lunarDayIndex = Number(e.detail.value);
    const lunarDay = this.data.lunarDays[lunarDayIndex];
    this.setData({ lunarDay, lunarDayIndex, birthdayDate: `${String(this.data.lunarMonth).padStart(2, '0')}-${String(lunarDay).padStart(2, '0')}`, error: '' });
  },
  clearBirthday() { this.setData({ birthdayType: '', birthdayTypeIndex: 0, birthdayDate: '', error: '' }); },
  saveBirthday() {
    if (this.data.busy) return;
    if (this.data.birthdayLocked) return this.setData({ error: '生日已经设置，如需调整请联系管理员' });
    if (!this.data.birthdayType || !/^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/.test(this.data.birthdayDate)) return this.setData({ error: '请选择正确的生日类型和日期' });
    this.setData({ busy: true, error: '' });
    api.request('/me/birthday', { method: 'PATCH', data: { birthdayType: this.data.birthdayType, birthdayDate: this.data.birthdayDate } }).then(({ user }) => {
      this.setData({ birthdayType: user.birthdayType || '', birthdayTypeIndex: ['', 'solar', 'lunar'].indexOf(user.birthdayType || ''), birthdayDate: user.birthdayDate || '', birthdayLocked: true });
      wx.showToast({ title: '生日已保存', icon: 'success' });
    }).catch(error => this.setData({ error: error.message || '生日保存失败，请重试' })).finally(() => this.setData({ busy: false }));
  },
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
