// After DATA, the provider may accept a message before the acknowledgement is lost.
export function mailOutcome(error) {
  const code = Number(error?.responseCode);
  if (error?.code === 'EAUTH' || code === 535) return 'auth_error';
  if (code >= 400 && code < 500) return 'retry';
  if (code >= 500 && code < 600) return 'failed';
  if (['CONN','EHLO','HELO','AUTH','MAIL FROM','RCPT TO'].includes(error?.command)) return 'retry';
  return 'uncertain';
}

export function createMailWorker({getContext, rpc, connect, clock = Date.now}) {
  return async request => {
    const reply = (status, body) => Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
    if (request.method !== 'POST') return reply(405,{error:'POST required'});
    const token = request.headers.get('x-mighty-mail-worker');
    if (!token || !/^[a-f0-9-]{72}$/.test(token)) return reply(403,{error:'Forbidden'});
    let transport;
    try {
      const sender = await getContext(token);
      if (request.headers.get('x-mighty-mail-check') === 'transport') {
        // Check TLS connectivity from the hosted runtime without authenticating
        // to a mailbox, claiming a delivery, or sending a message.
        transport = connect(null);
        await transport.verify();
        return reply(200,{connected:true});
      }
      if (!sender) return reply(200,{processed:0});
      transport = connect(sender);
      if (sender.state === 'pending') {
        try { await transport.verify(); }
        catch (error) {
          if (mailOutcome(error) === 'auth_error') await rpc('mighty_mail_sender_checked',{p_version:sender.version,p_ok:false});
          return reply(503,{error:'Sender verification pending'});
        }
        await rpc('mighty_mail_sender_checked',{p_version:sender.version,p_ok:true});
      }
      const until = clock()+30_000;
      let processed = 0;
      while (processed < 8 && clock() < until) {
        const job = await rpc('mighty_mail_take',{p_version:sender.version});
        if (!job) break;
        let outcome;
        try {
          await transport.sendMail({from:{name:'마이티 온라인',address:sender.sender},
            to:{address:job.recipient,name:''},envelope:{from:sender.sender,to:[job.recipient]},
            messageId:'<'+job.id+'@mighty-online.local>',subject:job.subject,text:job.body,
            disableFileAccess:true,disableUrlAccess:true});
          outcome = 'sent';
        } catch (error) { outcome=mailOutcome(error); }
        if (outcome==='auth_error') await rpc('mighty_mail_sender_checked',{p_version:sender.version,p_ok:false});
        await rpc('mighty_mail_finish',{p_id:job.id,p_lease:job.lease,p_outcome:outcome});
        processed++;
        if (outcome==='retry' || outcome==='auth_error') break;
      }
      return reply(200,{processed});
    } catch (error) {
      return error?.status === 403 ? reply(403,{error:'Forbidden'}) : reply(503,{error:'Mail processing unavailable'});
    } finally { transport?.close(); }
  };
}
