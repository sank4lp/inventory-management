const safeLink=href=>typeof href==='string'&&/^\/(?![\/\\])/.test(href)&&!/[\\\u0000-\u0020]/.test(href)?href:'';
// Browser-local history is isolated by warehouse, restored dataset and account.
export class NotificationStore {
  constructor({storage, scope, now=()=>Date.now(), id=()=>crypto.randomUUID()}={}) {
    Object.assign(this,{storage,now,id});
    this.key=scope ? 'lytguide-notifications-v1:'+JSON.stringify(scope) : null;
    this.rows=[];this.dismissed={}; this.sync();
  }
  sync() {
    if(!this.key)return;
    try {
      const saved=JSON.parse(this.storage?.getItem(this.key)||'[]');
      const rows=Array.isArray(saved)?saved:saved?.rows;
      if(Array.isArray(rows)) {
        this.dismissed=Array.isArray(saved)?{}:saved.dismissed||{};
        this.rows=rows.filter(row=>row&&typeof row.id==='string'&&typeof row.message==='string'&&Number.isFinite(row.at)&&!Number.isNaN(new Date(row.at).getTime())).map(row=>({...row,href:safeLink(row.href),read:Boolean(row.read)})).sort((a,b)=>b.at-a.at);
        // Older versions saved the same stocktaking reminder on every page load.
        let seen=false;this.rows=this.rows.filter(row=>{if(row.key!=='stocktaking-reminder')return true;if(seen)return false;seen=true;const run=new URL(row.href||'/stocktaking','http://warehouse').searchParams.get('run');if(run)row.key='stocktaking-run:'+run;return true;});
      }
    } catch { /* Notifications remain usable when browser storage is unavailable. */ }
  }
  save() { if(this.key)try{this.storage?.setItem(this.key,JSON.stringify({rows:this.rows,dismissed:this.dismissed}));}catch{} }
  add(message,{tone='info',key='',href=''}={}) {
    message=String(message||'').trim(); if(!message)return null;
    this.sync();
    // Polling the same health/reminder state must not create repeated alerts.
    if(key&&this.dismissed[key])return null;
    const previous=key&&this.rows.find(row=>row.key===key);
    if(previous?.message===message)return null;
    if(previous&&key.startsWith('stocktaking-run:')){previous.message=message;previous.href=safeLink(href);this.save();return null;}
    const row={id:this.id(),message,tone:['info','success','warning','error'].includes(tone)?tone:'info',key,href:safeLink(href),at:this.now(),read:false};
    this.rows.unshift(row);this.save();return row;
  }
  dismiss(id) {this.sync();const row=this.rows.find(row=>row.id===id);if(row?.key)this.dismissed[row.key]=true;this.rows=this.rows.filter(row=>row.id!==id);this.save();}
  clear() {this.sync();for(const row of this.rows)if(row.key)this.dismissed[row.key]=true;this.rows=[];this.save();}
  clearKey(key) { this.sync();let changed=Boolean(this.dismissed[key]);delete this.dismissed[key];for(const row of this.rows)if(row.key===key){row.key='';changed=true;}if(changed)this.save(); }
  read() { this.sync();for(const row of this.rows)row.read=true;this.save(); }
  get unread() { return this.rows.filter(row=>!row.read).length; }
}
