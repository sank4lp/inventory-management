import test from 'node:test';
import assert from 'node:assert/strict';
import {desktopTarget,originMatches,allowedRequest,externalLink,mediaAllowed,windowPreferences,launchMode} from '../src/desktop/policy.mjs';
test('desktop accepts only local warehouse and one-use Setup targets, not arbitrary locations or credentials',()=>{
 assert.equal(desktopTarget('http://localhost:3310/work').origin,'http://localhost:3310');assert.equal(desktopTarget('http://localhost:3311/#'+'a'.repeat(64),{setup:true}).port,'3311');
 for(const url of ['file:///etc/passwd','https://example.com/work','http://localhost.evil:3310/work','http://user:pass@localhost:3310/work','http://localhost:3310/admin','http://localhost:3310/work?bad=1','http://localhost:3310/work#x'])assert.throws(()=>desktopTarget(url),/Invalid/);
 for(const url of ['http://localhost:3311/','http://localhost:3310/#'+'a'.repeat(64),'http://localhost:3311/?x=1#'+'a'.repeat(64)])assert.throws(()=>desktopTarget(url,{setup:true}));
});
test('renderer navigation and requests stay within the selected service, including origin port boundaries',()=>{
 const origin='http://localhost:3310';assert.equal(originMatches(origin+'/products/1',origin),true);assert.equal(allowedRequest('ws://localhost:3310/events',origin),true);assert.equal(allowedRequest('blob:http://localhost:3310/id',origin),true);
 for(const url of ['http://localhost:3311/','http://127.0.0.1:3310/work','http://localhost.evil:3310/work','file:///etc/passwd','javascript:alert(1)','https://outside.example','http://user@localhost:3310/work']){assert.equal(originMatches(url,origin),false);assert.equal(allowedRequest(url,origin),false);}
 assert.equal(externalLink('https://www.electronjs.org/'),'https://www.electronjs.org/');for(const url of ['javascript:alert(1)','file:///etc/passwd','mailto:a@example.org','https://user:pass@example.org'])assert.equal(externalLink(url),null);
});
test('desktop permits QR video only for its own service; Node, insecure content and webviews remain disabled',()=>{
 const origin='http://localhost:3310';assert.equal(mediaAllowed(origin,origin+'/tasks/1','media',{mediaTypes:['video']}),true);
 for(const [url,permission,details] of [[origin,'media',{mediaTypes:['audio']}],[origin,'media',{mediaTypes:['video','audio']}],[origin,'media',{}],[origin,'display-capture',{mediaTypes:['video']}],['https://outside.example','media',{mediaTypes:['video']}]])assert.equal(mediaAllowed(origin,url,permission,details),false);
 const prefs=windowPreferences('persist:warehouse');assert.equal(prefs.partition,'persist:warehouse');for(const key of ['nodeIntegration','nodeIntegrationInWorker','nodeIntegrationInSubFrames','webviewTag','allowRunningInsecureContent'])assert.equal(prefs[key],false);for(const key of ['contextIsolation','sandbox','webSecurity'])assert.equal(prefs[key],true);
});
test('desktop launch and second-instance messages use only known modes',()=>{
 assert.equal(launchMode(['binary']),'work');assert.equal(launchMode(['binary','--lytguide-setup']),'setup');assert.equal(launchMode(['--lytguide-resume']),'resume');assert.throws(()=>launchMode(['--lytguide-url=https://outside.example']));assert.throws(()=>launchMode(['--lytguide-work','--lytguide-setup']));
});
