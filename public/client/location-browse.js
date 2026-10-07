export async function mount() {
const pageScope=globalThis.WarehousePageLifecycle?.current;
const setTimeout=(...args)=>pageScope?pageScope.timeout(...args):globalThis.setTimeout(...args);
const setInterval=(...args)=>pageScope?pageScope.interval(...args):globalThis.setInterval(...args);
const requestAnimationFrame=(...args)=>pageScope?pageScope.frame(...args):globalThis.requestAnimationFrame(...args);
const fetch=(...args)=>pageScope?pageScope.fetch(...args):globalThis.fetch(...args);
const onPage=(target,...args)=>pageScope?pageScope.listen(target,...args):target.addEventListener(...args);
let stream=null;
const status=document.querySelector('[data-browse-status]');
async function resolve(label){const r=await fetch('/api/locations/resolve?label='+encodeURIComponent(label));const v=await r.json();if(!r.ok)throw new Error(v.error);location.href='/cells/'+v.cellId;}
document.querySelector('[data-browse-qr]')?.addEventListener('submit',async ev=>{ev.preventDefault();try{await resolve(ev.target.elements.label.value);}catch(e){status.textContent=e.message;}});
document.querySelector('[data-location-mode]')?.addEventListener('submit',async ev=>{ev.preventDefault();const f=ev.target;try{const r=await fetch('/api/work/mode',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:crypto.randomUUID(),cellId:Number(f.dataset.locationMode),mode:f.elements.mode.value})});const v=await r.json();f.querySelector('[role=status]').textContent=v.message||v.error;}catch{f.querySelector('[role=status]').textContent='Not saved. Reconnect and check the current mode.';}});
const stop=()=>{stream?.getTracks().forEach(t=>t.stop());stream=null;};
document.querySelector('[data-browse-scan]')?.addEventListener('click',async()=>{try{stop();const host=document.querySelector('[data-browse-camera]');host.innerHTML='<video autoplay playsinline muted style="max-width:400px;width:100%"></video><button>Close camera</button>';host.querySelector('button').onclick=()=>{stop();host.innerHTML='';};stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}});const video=host.querySelector('video');video.srcObject=stream;await video.play();const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d',{willReadFrequently:true});async function frame(){if(!stream)return;if(video.videoWidth){canvas.width=video.videoWidth;canvas.height=video.videoHeight;ctx.drawImage(video,0,0);const qr=jsQR(ctx.getImageData(0,0,canvas.width,canvas.height).data,canvas.width,canvas.height);if(qr){stop();host.innerHTML='';try{await resolve(qr.data);}catch(e){status.textContent=e.message;}return;}}requestAnimationFrame(frame);}frame();}catch{stop();status.textContent='Camera unavailable. Enter the QR text manually.';}});
onPage(window,'pagehide',stop);
// Active navigation follows URL context, including dynamic product/location names.
const path=location.pathname,href=path.startsWith('/cells')?'/cells':null;if(href)for(const a of document.querySelectorAll('[data-nav-links] a')){a.classList.toggle('nav-link-active',a.getAttribute('href')===href);if(a.getAttribute('href')===href)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');}

}
if(typeof document!=='undefined'&&!globalThis.WarehouseNavigation?.mounting)await mount();
