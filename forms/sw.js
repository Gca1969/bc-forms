/* B&C Forms – network first, falls back to the saved copy when there is no signal. */
const C="bcforms-v1";
self.addEventListener("install",e=>self.skipWaiting());
self.addEventListener("activate",e=>e.waitUntil(self.clients.claim()));
self.addEventListener("fetch",e=>{if(e.request.method!=="GET")return;
  e.respondWith(fetch(e.request).then(r=>{if(r&&(r.ok||r.type==="opaque")){const c=r.clone();caches.open(C).then(x=>x.put(e.request,c))}return r})
  .catch(()=>caches.match(e.request,{ignoreSearch:false}).then(m=>m||caches.match(e.request,{ignoreSearch:true}))))});
