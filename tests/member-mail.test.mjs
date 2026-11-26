import test from 'node:test';
import assert from 'node:assert/strict';
import {createMailWorker,mailOutcome} from '../supabase/functions/member-mail/worker.js';

function fixture({state='ready',verifyError,sendError,ackError}={}) {
  const token='a'.repeat(72), seen=[], deliveries=[];
  const worker=createMailWorker({
    async getContext(key) { assert.equal(key,token); return {state,version:'s1',sender:'sender@example.invalid'}; },
    connect:()=>({
      async verify() {seen.push('verify'); if(verifyError) throw verifyError;},
      async sendMail(message) {deliveries.push(message);if(sendError)throw sendError;}, close() {}
    }),
    async rpc(name,args) {
      seen.push([name,args]);
      if (name==='mighty_mail_take' && !deliveries.length)
        return {id:'j1',lease:'l1',recipient:'only@example.invalid',subject:'안내',body:'대국 안내'};
      if (name==='mighty_mail_finish' && ackError) throw ackError;
      return null;
    }
  });
  const run=(key=token)=>worker(new Request('https://local.invalid',{method:'POST',headers:{'x-mighty-mail-worker':key}}));
  return {run,seen,deliveries};
}
test('only a scheduled call can verify the sender and send each queued message to its single envelope address',async()=>{
  const t=fixture({state:'pending'});
  assert.equal((await t.run('invalid')).status,403);
  assert.deepEqual(t.seen,[]);
  assert.equal((await t.run()).status,200);
  assert.deepEqual(t.seen.slice(0,2),['verify',['mighty_mail_sender_checked',{p_version:'s1',p_ok:true}]]);
  assert.deepEqual(t.deliveries[0].envelope,{from:'sender@example.invalid',to:['only@example.invalid']});
  assert.equal(t.deliveries[0].bcc,undefined);
  assert.equal(t.deliveries[0].cc,undefined);
  assert.equal(t.seen.at(-2)[1].p_outcome,'sent');
});
test('uncertain acceptance and acknowledgement loss do not submit another message',async()=>{
  for(const opts of [{sendError:Object.assign(new Error('closed'),{command:'DATA'})},{ackError:new Error('lost receipt')}]) {
    const t=fixture(opts); await t.run(); assert.equal(t.deliveries.length,1);
    const finish=t.seen.find(item=>item[0]==='mighty_mail_finish');
    assert.equal(finish[1].p_outcome,opts.ackError?'sent':'uncertain');
  }
  assert.equal(mailOutcome({responseCode:450}),'retry');
  assert.equal(mailOutcome({responseCode:550}),'failed');
});
test('a bad Gmail app password pauses the sender without claiming any waiting mail',async()=>{
  const t=fixture({state:'pending',verifyError:{code:'EAUTH',responseCode:535}});
  assert.equal((await t.run()).status,503);
  assert.deepEqual(t.seen,['verify',['mighty_mail_sender_checked',{p_version:'s1',p_ok:false}]]);
  assert.deepEqual(t.deliveries,[]);
});
