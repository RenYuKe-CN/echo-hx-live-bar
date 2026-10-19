const api=require('../../utils/api');
const service=require('../../utils/service');
const labels={prepared:'待确认兑换',verifying:'正在确认核销',unknown:'核销结果待确认',verified:'正在生成订单',success:'兑换成功 · 等待配送',failed:'未完成核销',cancelled:'已撤销'};
const format=r=>({...r,amountText:Number(r.amount).toFixed(2),statusLabel:labels[r.state]||r.state});
const requestId=()=> 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const n=Math.floor(Math.random()*16);return(c==='x'?n:(n&3)|8).toString(16);});
Page({
  data:{...service.initialData,platform:'meituan',code:'',platforms:{},records:[],preview:[],tableNo:'',connected:false,loading:true,busy:false,error:''},
  ...service.methods,
  onShow(){const app=getApp(),next={sessionId:app.globalData.sessionId,tableVersion:app.globalData.tableVersion};if(this.context && !this.matches(this.context))this.setData({preview:[],records:[],code:''});this.context=next;this.queryVersion=(this.queryVersion||0)+1;this.setData({tableNo:app.globalData.tableNo||'',connected:!!(app.globalData.hasScannedTable && this.context.sessionId),busy:false});this.startServicePolling();if(this.timer)clearInterval(this.timer);this.timer=setInterval(()=>{if(this.data.records.some(r=>['unknown','verifying','verified'].includes(r.state)))this.load();},5000);return this.load();},
  onHide(){this.stopServicePolling();if(this.timer)clearInterval(this.timer);this.timer=null;},
  onUnload(){this.onHide();},
  current(){const d=getApp().globalData;return this.context?.sessionId===d.sessionId && this.context.tableVersion===d.tableVersion;},
  matches(context){const d=getApp().globalData;return context?.sessionId===d.sessionId && context.tableVersion===d.tableVersion;},
  async load(){if(!this.data.connected)return this.setData({loading:false,error:'请先扫码或选择桌台再兑换团购券'});const version=this.readVersion=(this.readVersion||0)+1;try{const data=await api.request(`/sessions/${this.context.sessionId}/group-buy`);if(!this.current() || version!==this.readVersion)return;const records=data.records.map(format),preview=this.data.preview.map(item=>records.find(record=>record.id===item.id)||item);this.setData({platforms:data.platforms,records,preview,loading:false,...(preview.some(item=>item.state==='success')?{code:'',error:''}:{})});}catch(e){if(this.current() && version===this.readVersion)this.setData({loading:false,error:e.message});}},
  choosePlatform(e){if(this.data.busy)return;this.queryVersion=(this.queryVersion||0)+1;this.setData({platform:e.currentTarget.dataset.platform,preview:[],error:''});},
  onCode(e){this.queryVersion=(this.queryVersion||0)+1;this.setData({code:e.detail.value,preview:[],error:''});},
  paste(){if(this.data.busy)return;wx.getClipboardData({success:res=>{if(!this.data.busy)this.onCode({detail:{value:String(res.data||'').trim()}});},fail:()=>this.setData({error:'未能读取剪贴板，请手动粘贴券码'})});},
  async query(){
    if(this.data.busy || !this.data.connected)return;
    if(!this.data.platforms[this.data.platform]?.ready)return this.setData({error:this.data.platforms[this.data.platform]?.message || '自助兑换待开通，请联系服务员'});
    const code=this.data.code.replace(/\s/g,'');if(!code)return this.setData({error:'请填写核销码'});
    const context={...this.context},version=this.queryVersion=(this.queryVersion||0)+1;this.setData({busy:true,error:''});
    try{const data=await api.request(`/sessions/${this.context.sessionId}/group-buy/query`,{method:'POST',data:{platform:this.data.platform,code},timeout:20000});if(this.current() && version===this.queryVersion)this.setData({preview:data.records.map(format)});}
    catch(e){if(this.matches(context) && version===this.queryVersion)this.setData({error:e.message});}finally{if(this.matches(context) && version===this.queryVersion)this.setData({busy:false});}
  },
  async consume(e){
    if(this.data.busy || !this.data.connected)return;const id=e.currentTarget.dataset.id,record=this.data.preview.find(r=>r.id===id);if(record?.state!=='prepared')return;
    const context={...this.context},key=`echoGroupBuyCommand:${id}`,command=wx.getStorageSync(key)||requestId();wx.setStorageSync(key,command);
    this.setData({busy:true,error:''});
    try{const result=await api.request(`/sessions/${context.sessionId}/group-buy/${id}/consume`,{method:'POST',data:{requestId:command},timeout:20000});if(!this.matches(context))return;this.setData({preview:[format(result.record)],code:result.record.state==='success'?'':this.data.code});await this.load();}
    catch(e){if(this.matches(context)){this.setData({error:'兑换结果尚未确认，请刷新记录或联系服务员，重复请求不会重复配送。'});await this.load();}}finally{if(this.matches(context))this.setData({busy:false});}
  },
  openOrder(e){if(e.currentTarget.dataset.order)wx.navigateTo({url:`/pages/order-detail/order-detail?orderNo=${encodeURIComponent(e.currentTarget.dataset.order)}`});}
});
