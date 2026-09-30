const CACHE='lytguide-public-v23';
const ASSETS=['/offline','/stocktaking/offline','/styles.css','/client/stocktaking.js','/client/stocktake-status.js','/theme.css','/work.css','/responsive.css','/client/work.js','/client/searchable-select.js','/client/work-outbox-status.js','/client/vendor/jsQR.js','/brand/lytguide-icon.svg'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
 const u=new URL(event.request.url);
 if(u.origin!==location.origin||event.request.method!=='GET')return;
 if(event.request.mode==='navigate') {event.respondWith(fetch(event.request).catch(()=>caches.match(u.pathname.startsWith('/stocktaking')?'/stocktaking/offline':'/offline')));return;}
 if(ASSETS.includes(u.pathname))event.respondWith(fetch(event.request).catch(()=>caches.match(event.request)));
});
