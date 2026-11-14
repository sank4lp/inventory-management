// One presentation layer for page tables, dialog tables and dynamically loaded rows.
// Keep the original header controls; cloning them would break sorting and forms.
export function visibleTableRect(rect, clips) {
  return clips.reduce((r,c)=>({left:Math.max(r.left,c.left),top:Math.max(r.top,c.top),right:Math.min(r.right,c.right),bottom:Math.min(r.bottom,c.bottom)}),rect);
}
export function horizontalThumb(viewport,content,position,track) {
  const maximum=Math.max(0,content-viewport),width=Math.min(track,Math.max(32,track*viewport/Math.max(1,content)));
  return {maximum,width,left:maximum?Math.max(0,Math.min(maximum,position))/maximum*(track-width):0};
}
export function mountTableScrolling(doc=document) {
  const win=doc.defaultView, entries=new Map();let pending=0,serial=0,disposed=false,drag=null;
  const set=(el,key,value)=>{if(el.style.getPropertyValue(key)!==value)el.style.setProperty(key,value);};
  const schedule=()=>{if(!pending&&!disposed)pending=win.requestAnimationFrame(refresh);};
  const resize=new win.ResizeObserver(schedule);
  const wrappers='.table-wrap,.table-scroll,.ui-table-scroll,.work-table-wrap,.my-work-table-wrap,.report-summary-table-wrap,[data-table-scroll]';
  function add(table){
    if(entries.has(table)||!table.tHead||table.closest('[role="presentation"],[data-no-table-scroll]'))return;
    let wrap=table.parentElement;
    if(!wrap.matches(wrappers)&&!(wrap.children.length===1&&wrap.tagName==='DIV')){
      wrap=doc.createElement('div');table.before(wrap);wrap.append(table);
    }
    wrap.classList.add('persistent-table-scroll');table.classList.add('persistent-table');
    if(!wrap.hasAttribute('tabindex')){wrap.tabIndex=0;wrap.dataset.tableAddedTabindex='true';}
    const id=table.id||`scroll-table-${++serial}`;if(!table.id)table.id=id;
    const bar=doc.createElement('div');bar.className='table-horizontal-scroll';bar.hidden=true;bar.tabIndex=0;
    bar.setAttribute('role','scrollbar');bar.setAttribute('aria-orientation','horizontal');bar.setAttribute('aria-controls',id);bar.setAttribute('aria-valuemin','0');
    bar.setAttribute('aria-label',`Scroll ${table.getAttribute('aria-label')||wrap.getAttribute('aria-label')||table.caption?.textContent||'table'} horizontally`);
    const thumb=doc.createElement('div');thumb.className='table-horizontal-thumb';bar.append(thumb);
    const entry={table,wrap,bar,thumb,target:wrap};entries.set(table,entry);
    (table.closest('dialog,.modal-backdrop')||doc.body).append(bar);
    resize.observe(wrap);resize.observe(table);
    bar.addEventListener('pointerdown',e=>{
      if(e.button!==0)return;e.preventDefault();bar.focus({preventScroll:true});
      const r=bar.getBoundingClientRect(),t=thumb.getBoundingClientRect();
      if(e.target!==thumb)entry.target.scrollLeft+=(e.clientX<t.left?-1:1)*entry.target.clientWidth*.85;
      drag={entry,x:e.clientX,start:entry.target.scrollLeft,pointer:e.pointerId};bar.setPointerCapture(e.pointerId);schedule();
    });
    bar.addEventListener('pointermove',e=>{
      if(drag?.entry!==entry||drag.pointer!==e.pointerId)return;
      const geometry=horizontalThumb(entry.target.clientWidth,entry.target.scrollWidth,0,bar.clientWidth);
      entry.target.scrollLeft=drag.start+(e.clientX-drag.x)*geometry.maximum/Math.max(1,bar.clientWidth-geometry.width);schedule();
    });
    const end=e=>{if(drag?.entry===entry&&drag.pointer===e.pointerId){drag=null;if(bar.hasPointerCapture(e.pointerId))bar.releasePointerCapture(e.pointerId);}};
    bar.addEventListener('pointerup',end);bar.addEventListener('pointercancel',end);
    bar.addEventListener('keydown',e=>{
      const target=entry.target,max=target.scrollWidth-target.clientWidth;
      const keys={ArrowLeft:target.scrollLeft-40,ArrowRight:target.scrollLeft+40,PageUp:target.scrollLeft-target.clientWidth*.85,PageDown:target.scrollLeft+target.clientWidth*.85,Home:0,End:max};
      if(e.key in keys){e.preventDefault();target.scrollLeft=keys[e.key];schedule();}
    });
  }
  function refresh(){
    pending=0;if(disposed)return;
    for(const table of doc.querySelectorAll('table'))add(table);
    const vp=win.visualViewport,viewport={left:vp?.offsetLeft||0,top:vp?.offsetTop||0,right:(vp?.offsetLeft||0)+(vp?.width||win.innerWidth),bottom:(vp?.offsetTop||0)+(vp?.height||win.innerHeight)};
    const modals=[...doc.querySelectorAll('dialog[open],.modal-backdrop:not([hidden])')].filter(n=>n.getClientRects().length);
    for(const [table,entry] of entries){
      const {wrap,bar,thumb}=entry;
      if(!table.isConnected){resize.unobserve(table);resize.unobserve(wrap);bar.remove();entries.delete(table);continue;}
      if(!table.getClientRects().length||modals.length&&!modals.some(m=>m.contains(table))){bar.hidden=true;continue;}
      const rect=wrap.getBoundingClientRect(),tableRect=table.getBoundingClientRect(),clips=[viewport];
      const dialog=table.closest('dialog,.modal-backdrop');
      // Account for dialog bodies, nested panels and horizontally clipped parents.
      for(let p=wrap.parentElement;p&&p!==doc.body;p=p.parentElement){
        const style=win.getComputedStyle(p),r=p.getBoundingClientRect();
        const x=/(auto|scroll|hidden|clip)/.test(style.overflowX),y=/(auto|scroll|hidden|clip)/.test(style.overflowY);
        if(x||y)clips.push({left:x?r.left+p.clientLeft:-Infinity,right:x?r.left+p.clientLeft+p.clientWidth:Infinity,top:y?r.top+p.clientTop:-Infinity,bottom:y?r.top+p.clientTop+p.clientHeight:Infinity});
      }
      if(!dialog){
        const header=doc.querySelector('.page-header');
        if(header){const style=win.getComputedStyle(header),r=header.getBoundingClientRect();if(['sticky','fixed'].includes(style.position)&&r.bottom>viewport.top&&r.top<=viewport.top+1)clips.push({...viewport,top:r.bottom});}
      }
      if(dialog)for(const footer of dialog.querySelectorAll('.review-discard-footer,.ui-dialog-actions,.dialog-footer')){
        const style=win.getComputedStyle(footer),r=footer.getBoundingClientRect();
        if(['sticky','fixed'].includes(style.position)&&style.bottom!=='auto'&&r.bottom>viewport.top&&r.top<viewport.bottom)clips.push({...viewport,bottom:r.top});
      }
      const visible=visibleTableRect(rect,clips),height=visible.bottom-visible.top;
      // The offset also follows outer-page/dialog scrolling, not just table scroll.
      set(wrap,'--table-header-top',`${Math.max(0,visible.top-rect.top-wrap.clientTop)}px`);
      const head=table.tHead;
      if(head)set(head,'--table-head-background',win.getComputedStyle(head.rows[0]?.cells[0]||head).backgroundColor==='rgba(0, 0, 0, 0)'?'#edf4f0':win.getComputedStyle(head.rows[0]?.cells[0]||head).backgroundColor);
      // Mobile cards retain their labelled fields; their header's own scroll remains usable.
      const headerRow=head?.rows[0];entry.target=wrap.scrollWidth>wrap.clientWidth+1?wrap:headerRow&&headerRow.scrollWidth>headerRow.clientWidth+1?headerRow:wrap;
      const target=entry.target;
      const show=height>Math.max(40,(head?.getBoundingClientRect().height||0)+24)&&visible.right-visible.left>40&&target.scrollWidth>target.clientWidth+1&&tableRect.bottom>visible.top;
      bar.hidden=!show;if(!show)continue;
      // Host inside a native dialog so its top layer never covers the scrollbar.
      const host=dialog||doc.body;if(bar.parentElement!==host)host.append(bar);
      const barHeight=win.matchMedia('(pointer:coarse)').matches?26:18;
      set(bar,'left',`${visible.left}px`);set(bar,'top',`${visible.bottom-barHeight}px`);set(bar,'width',`${visible.right-visible.left}px`);set(bar,'height',`${barHeight}px`);
      const geometry=horizontalThumb(target.clientWidth,target.scrollWidth,target.scrollLeft,visible.right-visible.left);
      set(thumb,'width',`${geometry.width}px`);set(thumb,'transform',`translateX(${geometry.left}px)`);
      bar.setAttribute('aria-valuemax',String(geometry.maximum));bar.setAttribute('aria-valuenow',String(Math.round(target.scrollLeft)));
    }
  }
  const observer=new win.MutationObserver(records=>{if(records.some(r=>!r.target.closest?.('.table-horizontal-scroll')))schedule();});observer.observe(doc.body,{childList:true,subtree:true,attributes:true,attributeFilter:['open','hidden']});
  doc.addEventListener('scroll',schedule,true);doc.addEventListener('warehouse:table-layout',schedule);win.addEventListener('resize',schedule);win.addEventListener('warehouse:page-loaded',schedule);
  win.visualViewport?.addEventListener('resize',schedule);win.visualViewport?.addEventListener('scroll',schedule);doc.fonts?.ready.then(schedule);
  refresh();
  return ()=>{disposed=true;win.cancelAnimationFrame(pending);observer.disconnect();resize.disconnect();doc.removeEventListener('scroll',schedule,true);doc.removeEventListener('warehouse:table-layout',schedule);win.removeEventListener('resize',schedule);win.removeEventListener('warehouse:page-loaded',schedule);win.visualViewport?.removeEventListener('resize',schedule);win.visualViewport?.removeEventListener('scroll',schedule);for(const {bar}of entries.values())bar.remove();};
}
if(typeof document!=='undefined')mountTableScrolling();
