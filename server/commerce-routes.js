import QRCode from 'qrcode';
import { db } from './db.js';
import { storeName } from './branding.js';
import { commerceError,commerceSettings,saveCommerceSettings,reportWindow,formatTime,currentBusinessDate } from './business-time.js';
import { businessReport,reportWorkbook } from './business-report.js';
import { reportDetails,reportOrderDetail } from './report-views.js';
import { billData } from './bills.js';
import { receiptTemplate,saveReceiptTemplate,normalizeReceiptTemplate,receiptLines } from './receipts.js';
import { receiptPreview,createPrintJob,checkPrintJob,printJobView,dispatchPrintJob,updateJobState } from './printing.js';
import { feieProvider,feieStatus,feieConfiguration } from './integrations/feie.js';
import { saveUpload } from './storage.js';
import { withBackgroundTask } from './maintenance.js';
import { printerModels,defaultPrinterModel,printerConfiguration } from './printer-models.js';
const superOnly=req=>{if(req.staff.role!=='super')throw commerceError('仅超级管理员可配置打印机、模板和营业日',403);};
const safe=fn=>async(req,res)=>{try{await fn(req,res);}catch(e){res.status(e.status||409).json({message:e.message});}};
const printerView=value=>{const row=printerConfiguration(value);return {id:row.id,name:row.name,sn:row.sn,model:row.model,modelLabel:row.modelLabel,connection:row.connection,paperWidth:row.paper_width,printableWidth:row.printableWidth,dotsPerLine:row.dotsPerLine,columns:row.columns,hasCutter:!!row.has_cutter,status:row.status,bound:!!row.bound,boundUser:row.bound_user,boundRegion:row.bound_region,logoUrl:row.logo_url,keyConfigured:!!row.device_key};};
const withQr=async preview=>{for(const line of preview.lines)if(line.type==='qr')line.previewImage=await QRCode.toDataURL(line.content,{width:224,margin:2});return preview;};
export function registerCommerceRoutes(router,{audit}) {
  router.get('/admin/bills',safe((req,res)=>{
    const page=Math.max(1,parseInt(req.query.page)||1),size=Number(req.query.pageSize)===50?50:20,filter=req.query.status==='open'?"WHERE s.status='open'":req.query.status==='closed'?"WHERE s.status='closed'":'';
    const total=db.prepare('SELECT COUNT(*) AS n FROM table_sessions s '+filter).get().n,totalPages=Math.max(1,Math.ceil(total/size)),current=Math.min(page,totalPages);
    const sessions=db.prepare(`SELECT s.* FROM table_sessions s ${filter} ORDER BY s.status='open' DESC,s.id DESC LIMIT ? OFFSET ?`).all(size,(current-1)*size);
    res.json({bills:sessions.map(s=>{const b=billData(s.id);return {id:s.id,billNo:b.billNo,tableNo:b.tableNo,openedAt:formatTime(b.openedAt),closedAt:formatTime(b.closedAt),status:b.sessionStatus,orders:b.totals.orders,paidOrders:b.totals.paidOrders,pendingOrders:b.totals.pendingOrders,paid:b.totals.paid/100,refund:b.totals.refund/100,net:b.totals.net/100};}),pagination:{page:current,pageSize:size,total,totalPages,hasPrevious:current>1,hasNext:current<totalPages}});
  }));
  router.get('/admin/bills/:id',safe((req,res)=>res.json({bill:billData(Number(req.params.id))})));
  router.get('/admin/printing',safe((req,res)=>{
    const jobs=db.prepare('SELECT id FROM print_jobs ORDER BY created_at DESC,rowid DESC LIMIT 50').all().map(j=>printJobView(j.id));
    res.json({provider:feieStatus(),printerModels,defaultPrinterModel,storeName:storeName(),template:receiptTemplate(),printers:db.prepare('SELECT * FROM receipt_printers ORDER BY id').all().map(printerView),jobs,canConfigure:req.staff.role==='super',canResolve:['super','manager'].includes(req.staff.role)});
  }));
  router.put('/admin/printing/template',safe((req,res)=>{superOnly(req);res.json({template:saveReceiptTemplate(req.body)});audit(req,'更新小票固定版式');}));
  router.post('/admin/printing/template/preview',safe(async(req,res)=>{
    superOnly(req);const template=normalizeReceiptTemplate(req.body.template),data={scope:'bill',targetId:0,billNo:'B0000000001',tableNo:'A08',storeName:storeName(),sessionStatus:'closed',openedAt:new Date().toISOString(),closedAt:new Date().toISOString(),orders:[{orderNo:'示例订单',paymentStatus:'paid',paidAt:new Date().toISOString(),channels:[{label:'微信支付',amount:3800}],refunds:[],lines:[{name:'示例商品',quantity:1,unit:'瓶',amount:3800,original:3800,components:[]}]}],totals:{orders:1,paidOrders:1,pendingOrders:0,original:3800,memberDiscount:0,couponDiscount:0,paid:3800,refund:0,net:3800,channels:{wechat:3800}}};
    res.json(await withQr({lines:receiptLines(data,{paperWidth:Number(req.body.paperWidth)===80?80:58,template}),paperWidth:Number(req.body.paperWidth)===80?80:58,example:true}));
  }));
  router.post('/admin/printing/assets',safe(async(req,res)=>{
    superOnly(req);const match=/^data:image\/(png|jpeg|webp);base64,([a-zA-Z0-9+/=\r\n]+)$/.exec(req.body?.image||'');
    if(!match)throw commerceError('仅支持 PNG、JPEG、WebP 图片');
    const bytes=Buffer.from(match[2],'base64');
    if(bytes.length<16||bytes.length>2*1024*1024)throw commerceError('图片必须小于 2MB');
    const valid=match[1]==='png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):match[1]==='jpeg'?bytes[0]===255&&bytes[1]===216:bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP';
    if(!valid)throw commerceError('图片内容与格式不一致');
    const saved=await withBackgroundTask(()=>saveUpload({bytes,extension:match[1]==='jpeg'?'jpg':match[1],contentType:'image/'+match[1]}));audit(req,'上传小票图片',saved.name);res.status(201).json({url:saved.url});
  }));
  const savePrinter=(req,res,previous)=>{
    superOnly(req);const b=req.body||{},name=String(b.name??previous?.name??'').trim(),sn=String(b.sn??previous?.sn??'').trim(),key=String(b.key||previous?.device_key||'').trim(),model=b.model??previous?.model??defaultPrinterModel;
    const preset=printerModels.find(p=>p.model===model);
    if(!preset)throw commerceError('请选择支持的飞鹅小票机型号');
    const paperWidth=Number(b.paperWidth??preset.paperWidth??previous?.paper_width??58),hasCutter=b.hasCutter??preset.hasCutter??!!previous?.has_cutter,status=b.status??previous?.status??'active';
    if(!name||name.length>60||/[#\r\n]/.test(name)||!/^\d{6,32}$/.test(sn)||!/^[a-zA-Z0-9]{4,64}$/.test(key)||![58,80].includes(paperWidth)||typeof hasCutter!=='boolean'||!['active','disabled'].includes(status))throw commerceError('打印机名称、编号、KEY 或纸张规格无效');
    if(model==='fp-v58-h'&&(paperWidth!==58||hasCutter))throw commerceError('FP-V58-H 滴滴使用 58mm 纸、手动撕纸，不能设置为 80mm 或带切刀');
    if(previous&&sn!==previous.sn)throw commerceError('设备编号不能改为另一台打印机，请新增设备');
    if(previous&&(paperWidth!==previous.paper_width||Number(hasCutter)!==previous.has_cutter)&&db.prepare("SELECT 1 FROM print_jobs j JOIN print_parts p ON p.job_id=j.id WHERE j.printer_id=? AND j.state NOT IN ('printed','confirmed','cancelled') AND p.state IN ('queued','sending','accepted','unknown') LIMIT 1").get(previous.id))throw commerceError('这台打印机仍有未完成或待核对任务，请处理后再修改纸宽和切刀规格',409);
    let id=previous?.id;
    if(previous)db.prepare('UPDATE receipt_printers SET name=?,device_key=?,model=?,paper_width=?,has_cutter=?,status=? WHERE id=?').run(name,key,model,paperWidth,hasCutter?1:0,status,id);
    else id=db.prepare('INSERT INTO receipt_printers(name,sn,device_key,model,paper_width,has_cutter,status) VALUES(?,?,?,?,?,?,?)').run(name,sn,key,model,paperWidth,hasCutter?1:0,status).lastInsertRowid;
    audit(req,'保存小票打印机',`${id} ${name}`);res.json({printer:printerView(db.prepare('SELECT * FROM receipt_printers WHERE id=?').get(id))});
  };
  router.post('/admin/printing/printers',safe((req,res)=>savePrinter(req,res)));
  router.patch('/admin/printing/printers/:id',safe((req,res)=>{const p=db.prepare('SELECT * FROM receipt_printers WHERE id=?').get(req.params.id);if(!p)throw commerceError('打印机不存在',404);savePrinter(req,res,p);}));
  router.post('/admin/printing/printers/:id/bind',safe(async(req,res)=>{
    superOnly(req);const p=db.prepare('SELECT * FROM receipt_printers WHERE id=?').get(req.params.id);if(!p)throw commerceError('打印机不存在',404);
    await withBackgroundTask(()=>feieProvider().bind(p));const c=feieConfiguration();db.prepare('UPDATE receipt_printers SET bound=1,bound_user=?,bound_region=? WHERE id=?').run(c.user,c.region,p.id);audit(req,'绑定飞鹅打印机',p.name);res.json({ok:true});
  }));
  router.get('/admin/printing/printers/:id/status',safe(async(req,res)=>{const p=db.prepare('SELECT * FROM receipt_printers WHERE id=?').get(req.params.id);if(!p)throw commerceError('打印机不存在',404);res.json({status:await withBackgroundTask(()=>feieProvider().printerStatus(p.sn))});}));
  router.post('/admin/printing/printers/:id/logo-confirm',safe((req,res)=>{
    superOnly(req);if(req.body?.deviceLogoChecked!==true)throw commerceError('请先在飞鹅助手把当前 Logo 设置到此设备');
    if(db.prepare("SELECT 1 FROM print_jobs WHERE printer_id=? AND state IN ('queued','sending','accepted','unknown')").get(req.params.id))throw commerceError('这台打印机仍有未核对任务，请先处理旧任务再更换设备 Logo',409);
    const template=receiptTemplate(),asset=template.logoEnabled?template.logoUrl:template.qrMode==='device_image'?template.qrImageUrl:'';if(!asset)throw commerceError('请先上传并启用设备 Logo 或末尾小程序码位图');
    if(!db.prepare('UPDATE receipt_printers SET logo_url=? WHERE id=?').run(asset,req.params.id).changes)throw commerceError('打印机不存在',404);
    audit(req,'确认设备预置小票 Logo',req.params.id);res.json({ok:true});
  }));
  router.get('/admin/printing/preview',safe(async(req,res)=>res.json(await withQr(receiptPreview(req.query.scope,Number(req.query.targetId),Number(req.query.printerId),req.staff.display_name)))));
  router.post('/admin/printing/jobs',safe(async(req,res)=>{const job=await withBackgroundTask(()=>createPrintJob(req.body,req.staff));audit(req,job.reprintOf?'补打小票':'打印小票',job.id);res.status(201).json({job});}));
  router.post('/admin/printing/test',safe(async(req,res)=>{superOnly(req);const job=await withBackgroundTask(()=>createPrintJob(req.body,req.staff,{test:true}));audit(req,'测试小票打印',job.id);res.json({job});}));
  router.get('/admin/printing/jobs/:id',safe(async(req,res)=>res.json({job:await withQr(printJobView(req.params.id))})));
  router.post('/admin/printing/jobs/:id/check',safe(async(req,res)=>{const job=await withBackgroundTask(()=>checkPrintJob(req.params.id,{resume:req.body?.resume===true}));audit(req,'核对小票打印结果',job.id);res.json({job});}));
  router.post('/admin/printing/jobs/:id/resolve',safe(async(req,res)=>{
    if(!['super','manager'].includes(req.staff.role))throw commerceError('仅管理员可人工确认打印结果',403);
    const job=db.prepare('SELECT * FROM print_jobs WHERE id=?').get(req.params.id),b=req.body||{};
    if(job?.state!=='unknown'||b.paperChecked!==true||!['printed','not_printed'].includes(b.outcome)||!String(b.reason||'').trim()||String(b.reason).length>200)throw commerceError('请核对设备出纸与待打印队列，并填写处理说明');
    const parts=db.prepare('SELECT * FROM print_parts WHERE job_id=?').all(job.id);
    if(parts.some(p=>p.state==='sending'))throw commerceError('仍有内容正在提交，请稍后核对',409);
    if(b.outcome==='not_printed'&&parts.some(p=>p.expires_at&&Date.now()<p.expires_at*1000))throw commerceError('原任务仍在 15 分钟打印有效期内，暂不能确认停止等待',409);
    if(b.outcome==='printed'){db.prepare("UPDATE print_parts SET state='confirmed' WHERE job_id=? AND state IN ('unknown','accepted')").run(job.id);updateJobState(job.id);}
    else db.prepare("UPDATE print_jobs SET state='cancelled',error=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND state='unknown'").run(String(b.reason),job.id);
    audit(req,'人工核对打印结果',`${job.id} ${b.outcome} ${b.reason}`);
    const result=b.outcome==='printed'?await withBackgroundTask(()=>dispatchPrintJob(job.id)):printJobView(job.id);res.json({job:result});
  }));
  router.get('/admin/reports/settings',safe((_req,res)=>res.json({settings:commerceSettings()})));
  router.put('/admin/reports/settings',safe((req,res)=>{superOnly(req);res.json({settings:saveCommerceSettings(req.body)});audit(req,'更新营业日和报表文件名规则');}));
  router.get('/admin/reports',safe((req,res)=>{
    const report=businessReport(reportWindow(req.query)),t=report.totals;
    res.json({canConfigure:req.staff.role==='super',settings:commerceSettings(),currentBusinessDate:currentBusinessDate(),daily:report.daily,trend:report.trend,bySource:report.bySource,externalChannels:report.externalChannels,details:reportDetails(report),flows:report.flowViews.slice(-50).reverse(),dateRange:{startAt:report.window.start,endAt:report.window.end,timezone:report.window.timezone,filename:report.window.filename},totals:t,channels:report.channels,byProduct:report.byProduct.slice(0,50),productCount:report.byProduct.length,today:{day:report.window.start.slice(0,10),revenue:t.revenue,profit:t.profit,orders:t.orders,orderCost:t.orderCost,lossCost:t.lossCost,recharge:t.rechargeReceived,offline:t.offlineReceived},generatedAt:report.generatedAt});
  }));
  router.get('/admin/reports/details',safe((req,res)=>{const report=businessReport(reportWindow(req.query));res.json({...reportDetails(report,req.query),generatedAt:report.generatedAt});}));
  router.get('/admin/reports/orders/:id',safe((req,res)=>{const report=businessReport(reportWindow(req.query));res.json({order:reportOrderDetail(report,req.params.id)});}));
  router.get('/admin/reports/export',safe(async(req,res)=>{
    const report=businessReport(reportWindow(req.query));
    if(req.query.format==='csv'){const t=report.totals,csv=['日期,订单数,订单净销售额,充值收款,线下收款,订单商品成本,赠酒报损成本,商品毛利估算,毛利率,外部净收款',[report.window.start.slice(0,10),t.orders,t.revenue,t.rechargeReceived,t.offlineReceived,t.orderCost,t.lossCost,t.profit,t.grossMarginRate==null?null:(t.grossMarginRate*100).toFixed(2)+'%',t.externalNetReceived].map((v,i)=>i>1&&typeof v==='number'?v.toFixed(2):v??'').join(',')].join('\n');res.type('text/csv').send('\ufeff'+csv);return;}
    const buffer=await withBackgroundTask(()=>reportWorkbook(report));
    audit(req,'导出营业明细',`${report.window.filename} ${report.orders.length}笔`);
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('Content-Disposition',`attachment; filename="business-report.xlsx"; filename*=UTF-8''${encodeURIComponent(report.window.filename)}`);res.send(buffer);
  }));
}
