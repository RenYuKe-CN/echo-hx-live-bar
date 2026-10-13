import { db } from './db.js';
import { commerceError,formatTime } from './business-time.js';
import { isAllowedImageUrl } from './storage.js';
const defaults={storeNameOverride:'',headerLines:[],footerLines:[{text:'感谢光临',align:'center',size:'normal'}],logoUrl:'',logoEnabled:false,qrImageUrl:'',qrMode:'none',qrContent:'',qrCaption:'扫码进入门店小程序',showComponents:true};
export const receiptText=value=>String(value??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').replace(/</g,'＜').replace(/>/g,'＞');
export function receiptTemplate(){const row=db.prepare('SELECT * FROM receipt_templates WHERE id=1').get();return {...defaults,...JSON.parse(row.settings_json),revision:row.revision};}
export function normalizeReceiptTemplate(body) {
  const next={...defaults,...body};
  if(typeof next.storeNameOverride!=='string'||next.storeNameOverride.length>40||/[\u0000-\u001f\u007f]/.test(next.storeNameOverride))throw commerceError('小票店名最多 40 个字，不能包含换行或控制字符');
  next.storeNameOverride=next.storeNameOverride.trim();
  for(const section of ['headerLines','footerLines']) {
    if(!Array.isArray(next[section])||next[section].length>8)throw commerceError('抬头与末尾各最多 8 行');
    next[section]=next[section].map(line=>{
      if(typeof line?.text!=='string'||line.text.length>120||/[\r\n]/.test(line.text)||!['left','center','right'].includes(line.align)||!['normal','bold','large'].includes(line.size))throw commerceError('小票文字行、对齐或字号无效');
      return {text:line.text,align:line.align,size:line.size};
    });
  }
  for(const key of ['logoUrl','qrImageUrl'])if(typeof next[key]!=='string'||(next[key]&&!isAllowedImageUrl(next[key])))throw commerceError('请上传有效的门店图片');
  if(typeof next.logoEnabled!=='boolean'||typeof next.showComponents!=='boolean'||!['none','link','image','device_image'].includes(next.qrMode)||typeof next.qrContent!=='string'||next.qrContent.length>1024||typeof next.qrCaption!=='string'||next.qrCaption.length>60)throw commerceError('图片、二维码或套餐展示配置无效');
  if(next.logoEnabled&&!next.logoUrl)throw commerceError('启用 Logo 前请上传图片');
  if(['image','device_image'].includes(next.qrMode)&&!next.qrImageUrl)throw commerceError('请选择上传的小程序码图片');
  if(next.qrMode==='device_image'&&next.logoEnabled)throw commerceError('飞鹅只有一个预置位图位置。请选抬头 Logo 加链接二维码，或只在末尾打印预置小程序码图片');
  if(next.qrMode==='link'&&(!/^(?:https:\/\/|weixin:\/\/)/.test(next.qrContent)||/[<>\s\u0000-\u001f]/.test(next.qrContent)))throw commerceError('请填写有效的 HTTPS 小程序链接或微信跳转链接');
  delete next.revision;
  return next;
}
export function saveReceiptTemplate(body) {
  const next=normalizeReceiptTemplate(body);
  db.prepare('UPDATE receipt_templates SET settings_json=?,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=1').run(JSON.stringify(next));return receiptTemplate();
}
const cells=value=>[...value].reduce((n,c)=>n+(/[^\x00-\x7f]/.test(c)?2:1),0);
function wrap(value,width){const lines=[];let line='';for(const char of [...receiptText(value)]){if(char==='\n'||cells(line+char)>width){lines.push(line);line='';if(char==='\n')continue;}line+=char;}if(line)lines.push(line);return lines;}
const amount=cents=>(cents/100).toFixed(2);
export function receiptLines(data,{paperWidth=58,template=receiptTemplate(),reprint=false,operator=''}={}) {
  const width=paperWidth===80?48:32,lines=[];
  const add=(text,options={})=>{for(const piece of wrap(text,options.size==='large'?Math.floor(width/2):width))lines.push({text:piece,align:options.align||'left',size:options.size||'normal'});};
  const separator=()=>add('-'.repeat(width));
  const pair=(label,value)=>{const text=receiptText(label),right=receiptText(value);if(cells(text)+cells(right)+1>width){add(text);add(right,{align:'right'});}else add(text+' '.repeat(width-cells(text)-cells(right))+right);};
  add(template.storeNameOverride?.trim()||data.storeName,{align:'center',size:'large'});
  if(template.logoEnabled)lines.push({type:'logo',url:template.logoUrl});
  for(const line of template.headerLines)add(line.text,line);
  add(data.scope==='order'?'订单小票':data.sessionStatus==='closed'?'整桌消费账单':'消费清单（进行中）',{align:'center',size:'bold'});
  if(reprint)add('补打',{align:'center',size:'bold'});
  if(data.adjustedAfterClose)add('含结账后调整',{align:'center',size:'bold'});
  separator();add('桌号：'+data.tableNo);add('账单：'+data.billNo);
  add('开台：'+formatTime(data.openedAt));if(data.closedAt)add('结束：'+formatTime(data.closedAt));
  add(`包含订单：${data.totals.orders} 笔 / 已付 ${data.totals.paidOrders} 笔`);
  separator();
  // Merge only identical sale prices and compositions. Original order numbers
  // and payments remain below so an aggregate never erases the source ledger.
  const merged=new Map();
  for(const order of data.orders.filter(o=>o.paymentStatus==='paid'))for(const item of order.lines) {
    const key=JSON.stringify([item.name,item.unit,item.amount/item.quantity,item.components.map(p=>[p.name,p.quantity/item.quantity,p.unit])]);
    const row=merged.get(key)||{...item,quantity:0,amount:0,components:item.components.map(p=>({...p,quantity:0}))};
    row.quantity+=item.quantity;row.amount+=item.amount;item.components.forEach((p,i)=>row.components[i].quantity+=p.quantity);merged.set(key,row);
  }
  for(const item of merged.values()){add(item.name);pair(`  ${item.quantity}${item.unit} × ${amount(item.amount/item.quantity)}`,amount(item.amount));if(template.showComponents)for(const part of item.components)add(`    ${part.name} × ${part.quantity}${part.unit}`);}
  if(!merged.size)add('暂无成功付款商品');
  if(data.totals.pendingOrders){separator();add('未付款商品（未计入结算）',{size:'bold'});for(const order of data.orders.filter(o=>o.paymentStatus==='pending')){add(order.orderNo);for(const item of order.lines){add(item.name);pair(`  ${item.quantity}${item.unit}`,amount(item.amount));}}pair('待付款金额',amount(data.orders.filter(o=>o.paymentStatus==='pending').reduce((n,o)=>n+o.payable,0)));}
  separator();pair('商品原价',amount(data.totals.original));pair('会员优惠','-'+amount(data.totals.memberDiscount));pair('优惠券优惠','-'+amount(data.totals.couponDiscount));pair('累计结算',amount(data.totals.paid));
  for(const [channel,value] of Object.entries(data.totals.channels))pair(({wechat:'微信支付',stored:'储值本金',bonus:'赠金',cash:'现金',merchant_qr:'商家收款码',offline:'线下收款',meituan:'美团核销记账',douyin:'抖音核销记账'})[channel]||'其他支付',amount(value));
  pair('成功退款',amount(data.totals.refund));pair('净结算（含赠金抵扣）',amount(data.totals.net));
  if(data.totals.pendingOrders)add(`未付款订单 ${data.totals.pendingOrders} 笔，未计入以上结算`);
  separator();add('订单与付款记录',{size:'bold'});
  for(const o of data.orders){add(o.orderNo);add(`${formatTime(o.paidAt||o.createdAt)} ${o.paymentStatus==='paid'?'已付款':o.paymentStatus==='pending'?'待付款':'已取消'}`);for(const c of o.channels)pair(c.label,amount(c.amount));if(o.note)add('备注：'+o.note);for(const r of o.refunds){add('退款 '+formatTime(r.completedAt));pair(r.number,amount(r.amount));}}
  separator();if(operator)add('操作人：'+operator);add('打印：'+formatTime(new Date().toISOString()));
  if(template.qrMode!=='none') {lines.push({type:['image','device_image'].includes(template.qrMode)?'qr-image':'qr',deviceImage:template.qrMode==='device_image',url:template.qrImageUrl,content:template.qrContent});add(template.qrCaption,{align:'center'});}
  for(const line of template.footerLines)add(line.text,line);
  return lines;
}
export function feieReceiptParts(lines,printer,template) {
  if(template.qrMode==='image')throw commerceError('飞鹅标准小票接口不支持上传小程序码图片。请使用完整图片版系统打印，或配置链接二维码后云打印',409);
  if(template.logoEnabled&&printer.logo_url!==template.logoUrl)throw commerceError('当前 Logo 尚未确认设置到这台飞鹅打印机，请先完成设备 Logo 设置',409);
  if(template.qrMode==='device_image'&&printer.logo_url!==template.qrImageUrl)throw commerceError('请先在飞鹅助手把小程序码图片设置为此设备的预置位图并确认',409);
  const tags=lines.map(line=>{
    if(line.type==='logo')return '<LOGO><BR>';
    if(line.type==='qr')return '<QR>'+line.content+'</QR><BR>';
    if(line.type==='qr-image'){if(line.deviceImage)return '<LOGO><BR>';throw commerceError('上传的小程序码图片需要系统打印',409);}
    const text=receiptText(line.text),style=line.size==='large'?'B':line.size==='bold'?'BOLD':null,align=line.align==='center'?'C':line.align==='right'?'RIGHT':null;
    if(line.size==='large'&&line.align==='center')return '<CB>'+text+'</CB><BR>';
    let result=style?`<${style}>${text}</${style}>`:text;if(align)result=`<${align}>${result}</${align}>`;return result+'<BR>';
  });
  const parts=[];let current='';
  for(const tag of tags){if(Buffer.byteLength(current+tag+'<BR><BR><BR>')>4900){parts.push(current+'<BR><BR><BR>');current='';}if(Buffer.byteLength(tag)>4800)throw commerceError('单行小票内容过长');current+=tag;}
  if(current)parts.push(current+'<BR><BR><BR>');
  if(parts.length>1)for(let i=0;i<parts.length;i++)parts[i]=`<C>第 ${i+1}/${parts.length} 段</C><BR>`+parts[i];
  // FP-V3-WH has no cutter: feed only. Cutter-enabled models can opt in.
  if(printer.has_cutter)parts[parts.length-1]+='<CUT>';
  return parts;
}
