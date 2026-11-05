import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {createSessionCookie} from '../src/services/auth.js';

test('missing HTML resources terminate with a useful error and a safe parent link instead of a redirect loop',async()=>{
 process.env.NO_SERVER_LISTEN='1';process.env.HARDWARE_ADAPTER='simulator';process.env.DEMO_INVENTORY_SEED='1';
 process.chdir(mkdtempSync(join(tmpdir(),'lytguide-navigation-errors-')));
 const {requestHandler}=await import('../src/server.js');
 const {getAppState}=await import('../src/server/app-state.js');
 const {db}=getAppState(),user=db.prepare("SELECT * FROM users WHERE role='admin'").get();
 const call=async(path,accept='text/html')=>{
  const req=Readable.from([]);Object.assign(req,{method:'GET',url:path,headers:{host:'localhost',cookie:createSessionCookie(user),accept}});
  const res={statusCode:200,headers:{},body:'',writeHead(status,headers){this.statusCode=status;this.headers=headers;},end(body=''){this.body+=body;}};
  await requestHandler(req,res);return res;
 };
 for(const [path,parent,message] of [['/cells/999999','/cells',/Location not found/],['/backups/warehouse.xlsx','/backups',/Create a backup first/]]){
  const result=await call(path);
  assert.equal(result.statusCode,404,JSON.stringify({path,headers:result.headers,body:result.body.slice(0,400)}));assert.equal(result.headers.Location,undefined,path);
  assert.match(result.headers['Content-Type'],/text\/html/);assert.match(result.body,message);
  assert.ok(result.body.includes(`href="${parent}"`));
  const repeated=await call(path+'?flash=old-error&tone=error');assert.equal(repeated.statusCode,404);
  const api=await call(path,'application/json');assert.equal(api.statusCode,404);assert.match(api.headers['Content-Type'],/application\/json/);assert.match(JSON.parse(api.body).error,message);
 }
});
