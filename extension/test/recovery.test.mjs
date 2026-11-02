import test from 'node:test';
import assert from 'node:assert/strict';
import { repairAvailable, recoveryContext, launchRecovery, RECOVERY_HOST } from '../lib/recovery.js';
import { handoffEnabled } from '../lib/handoff-sites.js';
const failed = {source:{url:'https://youtube.com/watch?v=one'}, error:'Cannot reach the companion.', busy:false, result:null, mode:'codex-dip'};
test('repair is available only on Mac after an unsuccessful summary, never idle, busy, or with a summary', () => {
  assert.equal(repairAvailable(failed,'mac'),true);
  for (const change of [{source:null},{error:null},{busy:true},{result:'A finished summary'}]) assert.equal(repairAvailable({...failed,...change},'mac'),false);
  for (const platform of ['win','linux','']) assert.equal(repairAvailable(failed,platform),false);
  assert.equal(repairAvailable({...failed,error:'This video has no usable captions.'},'mac'),true);
});
test('successful summary preserves transcript handoff instead of repair', () => {
  const state = {...failed,result:'Summary',error:null,jobState:'done',jobId:'job'};
  assert.equal(handoffEnabled(state),true);
  assert.equal(repairAvailable(state,'mac'),false);
});
test('repair context whitelists diagnostics and never serializes configuration, token, transcript, or history', () => {
  const context = recoveryContext({...failed,cfg:{token:'secret'},token:'secret',thread:['private'],result:'transcript'},'1.4');
  assert.deepEqual(Object.keys(context).sort(),['error','jobId','mode','url','version']);
  assert.equal(JSON.stringify(context).includes('secret'),false);
});
test('a repair click requests native permission before native messaging; correct provider is preserved', async () => {
  const order=[];
  const chrome={permissions:{request: async p => {order.push('permission'); assert.deepEqual(p,{permissions:['nativeMessaging']}); return true;}},runtime:{sendNativeMessage:async (host,payload)=>{order.push('native');assert.equal(host,RECOVERY_HOST);assert.equal(payload.provider,'claude');assert.equal(payload.action,'repair');return {ok:true};}}};
  const pending=launchRecovery(chrome,'repair','claude',recoveryContext(failed,'1.4'));
  assert.deepEqual(order,['permission']);
  assert.equal((await pending).ok,true);assert.deepEqual(order,['permission','native']);
});
test('declining permission launches nothing, missing helper gives an actionable message',async()=>{
  let launches=0;
  const chrome={permissions:{request:async()=>false},runtime:{sendNativeMessage:async()=>{launches++;throw Error('missing host');}}};
  assert.equal((await launchRecovery(chrome,'recover',null,{})).ok,false);assert.equal(launches,0);
  chrome.permissions.request=async()=>true;
  assert.match((await launchRecovery(chrome,'recover',null,{})).message,/helper is unavailable/);assert.equal(launches,1);
});

test('configured bearer secret and URL credentials are removed before native IPC', () => {
  const context = recoveryContext({...failed, source:{url:'https://user:password@example.org/watch?v=abc&token=private'}, error:'Something echoed my-real-token'}, '1.4', 'my-real-token');
  assert.equal(context.url,'https://example.org/watch?v=abc');
  assert.equal(context.error.includes('my-real-token'),false);
  assert.equal(JSON.stringify(context).includes('password'),false);
});
