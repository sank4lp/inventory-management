import test from 'node:test';
import assert from 'node:assert/strict';
import {PageScope} from '../public/client/page-lifecycle.js';
import {navigationTarget} from '../public/client/navigation.js';

test('leaving awaits task pause and draft saving; a failed pause keeps the current page alive',async()=>{
 const scope=new PageScope(),events=[];let paused=false;
 scope.beforeLeave(async()=>{events.push('draft');await Promise.resolve();if(!paused)throw Error('Pause not confirmed');events.push('paused');});
 await assert.rejects(scope.leave(),/Pause not confirmed/);assert.equal(scope.active,true);
 paused=true;await scope.leave();assert.deepEqual(events,['draft','draft','paused']);scope.dispose();assert.equal(scope.active,false);
});
test('page disposal removes global handlers, stops timers/camera cleanup and aborts reads without cancelling a sent mutation',async()=>{
 const eventTarget=new EventTarget(),calls=[],pending=new Map(),cancelled=[],host={setTimeout:fn=>{const id=pending.size+1;pending.set(id,fn);return id;},clearTimeout:id=>cancelled.push(id),setInterval:()=>20,clearInterval:id=>cancelled.push(id),requestAnimationFrame:()=>30,cancelAnimationFrame:id=>cancelled.push(id),fetch:async(path,options)=>{calls.push(options);return {};}};
 const scope=new PageScope(host);let clicks=0,cameraStopped=0,timed=false;
 scope.listen(eventTarget,'click',()=>clicks++);scope.listen(eventTarget,'pagehide',()=>cameraStopped++);scope.timeout(()=>{timed=true;},100);scope.interval(()=>{},100);scope.frame(()=>{});
 eventTarget.dispatchEvent(new Event('click'));await scope.fetch('/read');await scope.fetch('/save',{method:'POST',body:'receipt-one'});scope.dispose();scope.dispose();eventTarget.dispatchEvent(new Event('click'));for(const callback of pending.values())callback();
 assert.equal(clicks,1);assert.equal(cameraStopped,1);assert.equal(timed,false);assert.equal(calls[0].signal.aborted,true);assert.equal(calls[1].signal,undefined);assert.equal(calls[1].body,'receipt-one');assert.deepEqual(cancelled.sort((a,b)=>a-b),[1,20,30]);assert.equal(scope.cleanups.size,0);
 await assert.rejects(scope.fetch('/old-read'),{name:'AbortError'});
});
test('completed one-shot timers do not accumulate for the lifetime of a running page',()=>{
 let execute;const scope=new PageScope({setTimeout:fn=>{execute=fn;return 1;},clearTimeout(){}});
 for(let n=0;n<100;n++){scope.timeout(()=>{},10);execute();assert.equal(scope.cleanups.size,0);}scope.dispose();
});
test('soft navigation stays on the warehouse origin and leaves authentication and API endpoints alone',()=>{
 assert.equal(navigationTarget('/work/history','http://warehouse/work').pathname,'/work/history');
 for(const href of ['https://other.example/work','/api/work/snapshot','/login','/logout','/offline'])assert.equal(navigationTarget(href,'http://warehouse/work'),null);
});
