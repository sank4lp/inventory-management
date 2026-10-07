const safeLink=href=>typeof href==='string'&&/^\/(?![\/\\])/.test(href)&&!/[\\\u0000-\u0020]/.test(href)?href:'';
// Browser-local history is isolated by warehouse, restored dataset and account.
export class NotificationStore {
  constructor({storage, scope, now=()=>Date.now(), id=()=>crypto.randomUUID()}={}) {
    Object.assign(this,{storage,now,id});
    this.key=scope ? 'lytguide-notifications-v1:'+JSON.stringify(scope) : null;
    this.rows=[]; this.sync();
  }
  sync() {
    if(!this.key)return;
    try {
      const saved=JSON.parse(this.storage?.getItem(this.key)||'[]');
      if(Array.isArray(saved)) {
        const merged=new Map(this.rows.map(row=>[row.id,row]));
        for(const row of saved)if(row&&typeof row.id==='string'&&typeof row.message==='string'&&Number.isFinite(row.at)&&!Number.isNaN(new Date(row.at).getTime())) {
          const current=merged.get(row.id);
          merged.set(row.id,{...row,href:safeLink(row.href),read:Boolean(row.read||current?.read)});
        }
        this.rows=[...merged.values()].sort((a,b)=>b.at-a.at);
      }
    } catch { /* Notifications remain usable when browser storage is unavailable. */ }
  }
  save() { if(this.key)try{this.storage?.setItem(this.key,JSON.stringify(this.rows));}catch{} }
  add(message,{tone='info',key='',href=''}={}) {
    message=String(message||'').trim(); if(!message)return null;
    this.sync();
    // Polling the same health/reminder state must not create repeated alerts.
    if(key&&this.rows.find(row=>row.key===key)?.message===message)return null;
    const row={id:this.id(),message,tone:['info','success','warning','error'].includes(tone)?tone:'info',key,href:safeLink(href),at:this.now(),read:false};
    this.rows.unshift(row);this.save();return row;
  }
  clearKey(key) { let changed=false;for(const row of this.rows)if(row.key===key){row.key='';changed=true;}if(changed)this.save(); }
  read() { this.sync();for(const row of this.rows)row.read=true;this.save(); }
  get unread() { return this.rows.filter(row=>!row.read).length; }
}
