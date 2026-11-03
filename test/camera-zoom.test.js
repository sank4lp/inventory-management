import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import {clampZoom,cameraCrop,mountCameraZoom} from '../public/client/camera-zoom.js';

function camera() {
  class Element {
    constructor(tag) {
      this.tagName=tag;this.children=[];this.listeners=new Map();this.captures=new Set();
      this.clientWidth=320;this.clientHeight=240;
      const classes=new Set();this.classList={contains:x=>classes.has(x),add:x=>classes.add(x),remove:x=>classes.delete(x)};
      this.style={removeProperty:name=>delete this.style[name]};
    }
    setAttribute() {}
    addEventListener(type,fn){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(fn);}
    removeEventListener(type,fn){this.listeners.get(type)?.delete(fn);}
    fire(type,values={}){for(const fn of this.listeners.get(type)||[])fn({target:this,preventDefault(){},...values});}
    append(child){child.remove();child.parentNode=this;this.children.push(child);}
    before(child){child.remove();const p=this.parentNode;child.parentNode=p;p.children.splice(p.children.indexOf(this),0,child);}
    remove(){if(this.parentNode){const p=this.parentNode;p.children.splice(p.children.indexOf(this),1);this.parentNode=null;}}
    closest(selector){return selector==='button'&&this.tagName==='button'?this:selector==='dialog'?this.parentNode?.closest(selector)||null:null;}
    setPointerCapture(id){this.captures.add(id);}
    hasPointerCapture(id){return this.captures.has(id);}
    releasePointerCapture(id){this.captures.delete(id);}
    set innerHTML(value){this.html=value;for(const tag of ['button','output','button'])this.append(doc.createElement(tag));}
    querySelector(selector){return this.children[selector==='[data-zoom-out]'?0:selector==='[data-zoom-in]'?2:1];}
  }
  const doc={createElement:tag=>{const e=new Element(tag);e.ownerDocument=doc;return e;}};
  const host=doc.createElement('section'),video=doc.createElement('video');video.videoWidth=1920;video.videoHeight=1080;host.append(video);
  const zoom=mountCameraZoom(video),viewport=host.children[0],controls=viewport.children[1];
  return {zoom,video,host,viewport,minus:controls.children[0],output:controls.children[1],plus:controls.children[2]};
}

test('zoom bounds and crop match a centred cover preview in portrait and landscape',()=>{
  assert.equal(clampZoom(0),1);assert.equal(clampZoom(9),4);assert.equal(clampZoom(NaN),1);
  assert.deepEqual(cameraCrop(1920,1080,320,240,2),{x:600,y:270,width:720,height:540});
  assert.deepEqual(cameraCrop(1080,1920,320,240,2),{x:270,y:757.5,width:540,height:405});
});

test('plus and minus change the same zoom used by the QR decoder and enforce limits',()=>{
  const c=camera();assert.equal(c.minus.disabled,true);assert.equal(c.output.value,'1×');
  c.plus.fire('click');assert.equal(c.zoom.zoom,1.25);assert.equal(c.video.style.transform,'scale(1.25)');
  c.zoom.setZoom(2);const draws=[],canvas={};c.zoom.drawFrame(canvas,{drawImage:(...args)=>draws.push(args)});
  assert.deepEqual(draws[0].slice(1),[600,270,720,540,0,0,720,540]);
  c.zoom.setZoom(99);assert.equal(c.plus.disabled,true);assert.equal(c.output.value,'4×');
  c.minus.fire('click');assert.equal(c.zoom.zoom,3.75);
  c.zoom.setZoom(1);c.zoom.drawFrame(canvas,{drawImage(){}});assert.equal(canvas.width,1280);assert.equal(canvas.height,960);
});

test('two-finger pinch zoom is scoped to the preview and re-starts from the current zoom',()=>{
  const c=camera(),touch=(id,x)=>({pointerType:'touch',pointerId:id,clientX:x,clientY:0});
  c.viewport.fire('pointerdown',touch(1,0));c.viewport.fire('pointerdown',touch(2,100));
  c.viewport.fire('pointermove',touch(2,200));assert.equal(c.zoom.zoom,2);
  c.viewport.fire('pointerup',touch(2,200));c.viewport.fire('pointermove',touch(1,10));assert.equal(c.zoom.zoom,2);
  c.viewport.fire('pointerdown',touch(2,210));c.viewport.fire('pointermove',touch(2,110));assert.equal(c.zoom.zoom,1);
  c.viewport.fire('pointercancel',touch(1,10));c.viewport.fire('pointercancel',touch(2,110));
  c.viewport.fire('pointerdown',{...touch(3,0),target:c.plus});c.viewport.fire('pointerdown',touch(4,100));
  c.viewport.fire('pointermove',touch(4,200));assert.equal(c.zoom.zoom,1,'touching a zoom button is not a pinch');
  c.viewport.fire('pointerdown',{...touch(5,300),pointerType:'mouse'});c.viewport.fire('pointermove',{...touch(5,600),pointerType:'mouse'});assert.equal(c.zoom.zoom,1);
});

test('closing a camera removes its controls, captured pointers and handlers without stopping the owner stream',()=>{
  const c=camera();c.zoom.setZoom(2);c.viewport.fire('pointerdown',{pointerType:'touch',pointerId:1,clientX:0,clientY:0});
  c.zoom.dispose();c.zoom.dispose();assert.deepEqual(c.host.children,[c.video]);assert.equal(c.video.style.transform,undefined);
  assert.equal(c.viewport.captures.size,0);assert.equal([...c.viewport.listeners.values()].reduce((n,s)=>n+s.size,0),0);
  c.plus.fire('click');assert.equal(c.zoom.zoom,2);assert.equal(c.zoom.drawFrame({},{}),false);
});

test('an actual QR is readable within the zoomed crop and not outside the visible area',()=>{
  const sourceWidth=800,sourceHeight=600,qr=QRCode.create('lightguide-visible-qr',{errorCorrectionLevel:'M'}).modules;
  function decode(position,zoom){
    const crop=cameraCrop(sourceWidth,sourceHeight,320,240,zoom),width=Math.round(crop.width),height=Math.round(crop.height),pixels=new Uint8ClampedArray(width*height*4),moduleSize=4;
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      const col=Math.floor((x+crop.x-position.x)/moduleSize),row=Math.floor((y+crop.y-position.y)/moduleSize);
      const black=col>=0&&row>=0&&col<qr.size&&row<qr.size&&qr.get(row,col),at=(y*width+x)*4;
      pixels[at]=pixels[at+1]=pixels[at+2]=black?0:255;pixels[at+3]=255;
    }
    return jsQR(pixels,width,height);
  }
  assert.equal(decode({x:350,y:250},2)?.data,'lightguide-visible-qr');
  assert.equal(decode({x:20,y:20},1)?.data,'lightguide-visible-qr');
  assert.equal(decode({x:20,y:20},2),null);
});

test('camera controls load in the local/offline app and all scanner paths decode their visible crop',()=>{
  const read=file=>readFileSync(new URL('../'+file,import.meta.url),'utf8');
  for(const file of ['public/client/work.js','public/client/stocktaking.js','public/client/location-setup.js','public/client/location-browse.js']){
    const source=read(file);assert.match(source,/camera\.mountCameraZoom\(video\)/);assert.match(source,/cameraZoom\??\.drawFrame\(canvas,ctx\)/);assert.doesNotMatch(source,/ctx\.drawImage\(video,0,0\)/);
  }
  for(const file of ['src/render.js','src/modules/operations/routes.js','public/sw.js'])assert.match(read(file),/\/client\/camera-zoom\.js/);
});
