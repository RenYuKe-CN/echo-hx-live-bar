import test from 'node:test';
import assert from 'node:assert/strict';
import {miniappFixture} from './helpers/miniapp.mjs';
const types={help:'呼叫服务员',tissue:'需要纸巾',cleanup:'收拾桌面',remind:'催单',other:'其他帮助'};

test('a service call stays bound to the scanned table and preserves the same idempotency key on retry',async()=>{
 let failed=true, submitted=false;
 const fixture=miniappFixture({request:async(url,options)=>{
  if(url==='/sessions/1/services'){
   if(options.method==='POST'){submitted=true;if(failed){failed=false;throw new Error('connection lost after submission');}return{request:{id:1},repeated:true};}
   return{types,requests:submitted?[{id:1,type:'tissue',title:'需要纸巾',status:'waiting',notes:[{content:'请再给两份纸巾'}]}]:[]};
  }
 }});
 const page=fixture.loadPage('menu');await page.onShow();page.selectServiceType({currentTarget:{dataset:{type:'tissue'}}});page.onServiceNote({detail:{value:'请再给两份纸巾'}});
 await page.submitService();assert.equal(page.data.serviceBusy,false);assert.equal(page.data.serviceNote,'请再给两份纸巾');assert.match(page.data.serviceLoadError,/重试/);
 await page.submitService();const submissions=fixture.calls.filter(call=>call.url==='/sessions/1/services'&&call.method==='POST');assert.equal(submissions.length,2);
 assert.equal(submissions[0].data.requestId,submissions[1].data.requestId);assert.equal(submissions[0].data.note,'请再给两份纸巾');
 assert.equal(page.data.serviceRequests[0].statusLabel,'等待响应');assert.equal(page.data.servicePendingCount,1);assert.equal(page.data.serviceNote,'');
});

test('unscanned browsing never silently uses a default table or submits a service request',async()=>{
 const fixture=miniappFixture();fixture.app.globalData.hasScannedTable=false;fixture.app.globalData.tableNo='';fixture.app.globalData.sessionId=null;
 const page=fixture.loadPage('menu');await page.onShow();page.openService();await page.submitService();
 assert.equal(page.data.tableNo,'');assert.equal(page.data.serviceVisible,false);
 assert.equal(fixture.calls.some(call=>call.url.startsWith('/tables/')),false);assert.equal(fixture.calls.some(call=>call.url.includes('/services')),false);
 assert.equal(await page.updateProductQuantity(1,1),false);
});

test('other service demands require a note and completed requests show the handling employee',async()=>{
 const fixture=miniappFixture({request:async url=>{if(url==='/sessions/1/services')return{types,requests:[{id:2,type:'other',title:'其他帮助',status:'completed',assignedStaff:'小王',completionNote:'已协助',notes:[{content:'帮忙调整空调'}]}]};}});
 const page=fixture.loadPage('menu');await page.onShow();page.selectServiceType({currentTarget:{dataset:{type:'other'}}});await page.submitService();
 assert.equal(fixture.calls.some(call=>call.method==='POST'),false);assert.equal(page.data.serviceRequests[0].statusLabel,'已处理');assert.equal(page.data.serviceRequests[0].assignedStaff,'小王');assert.equal(page.data.serviceRequests[0].notesText,'帮忙调整空调');
});

test('partial delivery refund estimates keep the original payment basis',async()=>{
 const fixture=miniappFixture({request:async url=>{if(url.startsWith('/me/orders/'))return{order:{orderNo:'TEST',items:[{id:1,name:'啤酒',quantity:2,paidPrice:30,originalPrice:30,originalSubtotal:60,paidSubtotal:60,refundSelectable:true,refundAvailableQuantity:1,refundBaseQuantity:2}],refundableAmount:30,refundPaymentRemaining:60}};}});
 const page=fixture.loadPage('order-detail');page.setData({order:{items:[{id:1,paidPrice:30,refundSelectable:true,refundAvailableQuantity:1,refundBaseQuantity:2}],refundableAmount:30,refundPaymentRemaining:60},refundItems:[{orderItemId:1,quantity:1}]});page.calculateRefundEstimate();assert.equal(page.data.refundAmountText,'30.00');
});
