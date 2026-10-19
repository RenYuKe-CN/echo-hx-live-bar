const api = require('./api');
const key = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const n=Math.floor(Math.random()*16);return(c==='x'?n:(n&3)|8).toString(16);});
const confirm = options => new Promise(resolve=>wx.showModal({...options,success:r=>resolve(!!r.confirm),fail:()=>resolve(false)}));
const initialData = { tablePickerVisible:false, tableOptions:[], filteredTables:[], tableSearch:'', tableFilter:'all', tableCounts:{all:0,idle:0,occupied:0}, tableLoading:false, tableSwitching:false, tableError:'' };
const methods = {
  async openTables() {
    if(getApp().globalData.checkoutInProgress || this.data.cartBusy || this.data.serviceBusy || this.data.tableSwitching) return wx.showToast({title:'当前操作正在提交，请稍等',icon:'none'});
    wx.hideTabBar?.({animation:false});
    this.setData({tablePickerVisible:true,tableLoading:true,tableError:'',tableSearch:'',tableFilter:'all'});
    try {await getApp().apiReady;const result=await api.request('/tables');this.setData({tableOptions:result.tables});this.filterTables();}
    catch(error){this.setData({tableError:error.message || '桌台未能加载，请重试'});}
    finally{this.setData({tableLoading:false});}
  },
  filterTables() {
    const normalize=value=>String(value || '').replace(/[\s_-]/g,'').toLowerCase();
    const query=normalize(this.data.tableSearch), tables=this.data.tableOptions;
    this.setData({tableCounts:{all:tables.length,idle:tables.filter(t=>!t.occupied).length,occupied:tables.filter(t=>t.occupied).length},
      filteredTables:tables.filter(t=>(this.data.tableFilter==='all'||(this.data.tableFilter==='idle'?!t.occupied:t.occupied))&&normalize(t.tableNo).includes(query))});
  },
  onTableSearch(event){this.setData({tableSearch:event.detail.value});this.filterTables();},
  clearTableSearch(){this.setData({tableSearch:''});this.filterTables();},
  chooseTableFilter(event){if(this.data.tableSwitching)return;const filter=event.currentTarget.dataset.filter;if(!['all','idle','occupied'].includes(filter))return;this.setData({tableFilter:filter});this.filterTables();},
  closeTables(){if(!this.data.tableSwitching){this.setData({tablePickerVisible:false});wx.showTabBar?.({animation:false});}},
  chooseTable(event){const table=this.data.tableOptions.find(row=>row.id===Number(event.currentTarget.dataset.id));if(table)return this.switchTable(table).then(changed=>{if(changed)return this.load().then(()=>this.refreshServices());});},
  async switchTable(table) {
    if(getApp().globalData.checkoutInProgress || this.data.tableSwitching || this.data.serviceBusy)return false;
    this.setData({tableSwitching:true,tableError:''});
    try {
      await (this.cartUpdateQueue || Promise.resolve()).catch(()=>{});
      const app=getApp(),oldId=app.globalData.sessionId;
      const content=(table.occupied?'该桌正在使用，请确认您已在此桌就座。':'请确认您已在此桌就座。')+(oldId?'切换只影响之后点单，已支付订单仍配送到原桌。':'同桌顾客会共用购物车和桌台订单。');
      if(!await confirm({title:`选择 ${table.tableNo} 桌`,content,confirmText:'确认就座'}))return false;
      const own=(this.data.cart || []).some(row=>Number(row.added_by_user_id)===Number(app.globalData.user?.id));
      let cartAction='keep';
      if(oldId && own) {
        const move=await new Promise(resolve=>wx.showActionSheet({itemList:['保留我的未下单商品在原桌','移动我的未下单商品到新桌'],success:r=>resolve(r.tapIndex===1),fail:()=>resolve(null)}));
        if(move===null)return false;cartAction=move?'move':'keep';
      }
      const fingerprint=JSON.stringify([table.id,oldId,cartAction]);
      if(this.tableCommand?.fingerprint!==fingerprint)this.tableCommand={fingerprint,requestId:key()};
      const result=await api.request('/tables/select',{method:'POST',data:{tableId:table.id,currentSessionId:oldId || null,cartAction,confirmed:true,requestId:this.tableCommand.requestId}});
      if(result.session.id===oldId && result.table.tableNo===app.globalData.tableNo){app.globalData.pendingScene='';app.globalData.pendingTableNo='';this.setData({tablePickerVisible:false});return true;}
      app.globalData.sessionId=result.session.id;app.globalData.tableNo=result.table.tableNo;app.globalData.hasScannedTable=true;
      app.globalData.pendingScene='';app.globalData.pendingTableNo='';app.globalData.tableVersion++;
      app.globalData.pendingCouponId='';app.globalData.pendingCouponMode='';this.tableCommand=null;
      this.setData({tablePickerVisible:false,tableNo:result.table.tableNo,selectedCouponId:'',couponCheckout:null});
      return true;
    } catch(error){this.setData({tableError:error.message || '切换结果暂未确认，请重试'});wx.showToast({title:error.message || '选桌失败，请重试',icon:'none'});return false;}
    finally{this.setData({tableSwitching:false});if(!this.data.tablePickerVisible)wx.showTabBar?.({animation:false});}
  },
  async resolvePendingTable() {
    const app=getApp(),scene=app.globalData.pendingScene,tableNo=app.globalData.pendingTableNo;
    if(!scene && !tableNo)return;
    const result=scene?await api.request('/tables/resolve?scene='+encodeURIComponent(scene)):null;
    const tables=await api.request('/tables');
    const table=tables.tables.find(row=>row.tableNo===(result?.table.tableNo || tableNo));
    if(!table)throw new Error('桌台不存在或已停用');
    const changed=await this.switchTable(table);
    if(!changed){app.globalData.pendingScene='';app.globalData.pendingTableNo='';}
  }
};
module.exports={initialData,methods};
