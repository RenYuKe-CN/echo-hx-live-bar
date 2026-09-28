const api = require('../../utils/api');
Page({ data: { records: [] }, onShow() { api.request('/me/storage').then(data => this.setData({ records: data.records.filter(item => item.status === 'stored' && item.quantity > 0) })); } });
