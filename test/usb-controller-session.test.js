import test from 'node:test';
import assert from 'node:assert/strict';
import {openUsbControllerSession} from '../src/services/usb-controller-session.js';
import {firmwareFailure} from '../src/services/firmware-errors.js';

function fixture({reply='{"type":"ack"}\n',fragment=false,eagain=false,partial=false,disconnect=false}={}){
 let clock=0,closed=0,started=false,writes='',pending=[],attempted=false;
 const io={openSync:()=>7,closeSync:()=>closed++,readSync(fd,b){if(disconnect&&started)throw Object.assign(new Error('USB disconnected'),{code:'EIO'});const text=pending.shift();if(!text)throw Object.assign(new Error(),{code:'EAGAIN'});b.write(text);return Buffer.byteLength(text);},writeSync(fd,b,offset,length){started=true;if(eagain&&!attempted){attempted=true;throw Object.assign(new Error(),{code:'EAGAIN'});}const text=b.subarray(offset,offset+(partial?Math.min(length,3):length)).toString();writes+=text;if(text.includes('\n'))pending.push(...(fragment?['boot noise\n{"type":','"ack"}\n']: [reply]));return Buffer.byteLength(text);}};
 const session=openUsbControllerSession('/dev/test',{configureSerial:()=>({status:0})},{io,waitFor:async ms=>{clock+=ms;},now:()=>clock,bootWaitMs:1500});
 return {session,clock:()=>clock,writes:()=>writes,closed:()=>closed};
}
for(const options of [{},{partial:true},{eagain:true,partial:true},{fragment:true}])test(`USB exchange waits for boot and handles ${JSON.stringify(options)}`,async()=>{
 const f=fixture(options),command='to CTRL config-status 0123456789abcdef';
 assert.equal((await f.session.exchange(command,r=>r.type==='ack')).type,'ack');assert.ok(f.clock()>=1500);assert.equal(f.writes(),command+'\n');f.session.close();f.session.close();assert.equal(f.closed(),1);
 await assert.rejects(()=>f.session.exchange(command,()=>true),/session closed/);
});
test('controller errors are surfaced immediately; stale or absent acknowledgements do not verify a write',async()=>{
 const error=fixture({reply:'{"type":"error","message":"config-storage-failed"}\n'});
 await assert.rejects(()=>error.session.exchange('to CTRL configure 0123456789abcdef',()=>true),/config-storage-failed/);error.session.close();
 const lost=fixture({reply:'{"type":"ack","request":"stale"}\n'});
 await assert.rejects(()=>lost.session.exchange('to CTRL config-status 0123456789abcdef',r=>r.request==='current',{attempts:2,timeoutMs:100}),/confirmation timed out/);assert.equal(lost.writes().split('\n').length-1,2);lost.session.close();
 const unplugged=fixture({disconnect:true});await assert.rejects(()=>unplugged.session.exchange('to CTRL config-status 0123456789abcdef',()=>true),/USB disconnected/);unplugged.session.close();
});
test('USB maintenance refuses ordinary LED commands and invalid retry settings',async()=>{
 const f=fixture();for(const command of ['to CTRL off-all','to CTRL config-status x\n','to CTRL configure '+ 'x'.repeat(320)])await assert.rejects(()=>f.session.exchange(command,()=>true),/Invalid USB maintenance/);
 await assert.rejects(()=>f.session.exchange('to CTRL config-status x',()=>true,{attempts:0}),/timeout/);assert.equal(f.writes(),'');f.session.close();
});
test('common failures have an actionable recovery path',()=>{
 for(const [message,stage,expected] of [['EACCES Permission denied','identifying',/permissions/],['EIO disconnected','verifying',/USB data cable/],['EBUSY','uploading',/serial monitors/],['ENOSPC','compiling',/Free space/],['config-storage-failed','verifying',/rejected its LED setup/],['Controller USB confirmation timed out','verifying',/not verified/],['Connecting failed','uploading',/BOOT/],['Compiler missing','compiling',/Nothing was uploaded/]])assert.match(firmwareFailure(new Error(message),stage).hint,expected);
});
