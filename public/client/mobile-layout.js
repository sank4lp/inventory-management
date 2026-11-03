import {arrangeMobileControls} from './mobile-controls.js';
// The same table cells and controls are presented as labelled entries on phones.
// Never clone a form or submit a task from this presentation module.
export function mobileColumnLabel(header) {
  return (header.querySelector?.('a')?.textContent || header.textContent || '')
    .replace(/[↑↓↕]/g, '').replace(/\s+/g, ' ').trim();
}
export function taskColumnLayout(headers, available) {
  const aliases = {'Task ID':'task','Product':'product','Change':'change','Assigned To':'assignedTo','Assigned By':'assignedBy','Changed By':'changedBy','Timestamp (IST)':'timestamp','Cell':'cell','Details before':'before','Details after':'after'};
  const keys = headers.map((header, index) => header.dataset.column || aliases[mobileColumnLabel(header)] || (header.querySelector?.('input[type=checkbox]') ? 'selection' : 'column-' + index));
  const leading = ['selection', 'task', 'product', 'requested', 'change', 'action'].filter(key => keys.includes(key));
  const order = [...leading, ...keys.filter(key => !leading.includes(key))];
  const fixed = keys.includes('selection') ? {selection:28,task:48,requested:48,action:72} : {task:52,requested:72,action:80};
  fixed.change=108;
  const base = leading.reduce((sum,key)=>sum+(fixed[key]||0),0);
  const defaults = {type:76,unit:72,assignedTo:180,completed:100,remaining:100,priority:100,status:150,progress:100,state:170,before:150,after:150,timestamp:160,cell:120,assignedBy:150,changedBy:150};
  const widths = order.map(key => key === 'product' ? Math.max(64,Math.min(300,available-base)) : fixed[key] || defaults[key] || 120);
  return {keys,order,widths};
}
export function prepareMobileTable(table) {
  if (table.closest('.report-document,.report-format-preview,[data-mobile-table="scroll"]')) return;
  const headers = [...(table.tHead?.rows[0]?.cells || [])];
  if (!headers.length || headers.some(header => header.colSpan > 1)) return;
  // Matrix headers with multiple levels are kept as a scrollable matrix.
  if (table.tHead.rows.length !== 1) return;
  if ((headers.some(header=>header.dataset.column==='task') && headers.some(header=>header.dataset.column==='requested')) || table.classList.contains('task-timeline')) {
    table.classList.add('mobile-task-table');
    // Explicit table/row semantics survive the visual grid in mobile WebKit.
    table.setAttribute('role','table');table.tHead.setAttribute('role','rowgroup');
    table.tHead.rows[0].setAttribute('role','row');
    for(const body of table.tBodies){body.setAttribute('role','rowgroup');for(const row of body.rows)row.setAttribute('role','row');}
    const {keys,order,widths}=taskColumnLayout(headers,table.parentElement.clientWidth);
    // Keep the new Stocktake identity readable without pushing the basic phone
    // columns off-screen; borrow space from Product when that column can spare it.
    if(table.querySelector('tbody [data-stocktake-id]')){
      const task=order.indexOf('task'),product=order.indexOf('product');
      if(task>=0&&product>=0){const extra=Math.min(32,Math.max(0,widths[product]-64));widths[task]+=extra;widths[product]-=extra;}
    }
    let stored;try{stored=JSON.parse(table.dataset.mobileColumnWidths||'null');}catch{}
    if(Array.isArray(stored)&&stored.length===keys.length&&stored.every(width=>Number.isFinite(width)&&width>=48)) {
      order.forEach((key,index)=>{widths[index]=stored[keys.indexOf(key)];});
    }
    table.style.setProperty('--mobile-table-columns',widths.map(width=>width+'px').join(' '));
    table.style.setProperty('--mobile-table-width',widths.reduce((sum,width)=>sum+width,0)+'px');
    keys.forEach((key,index)=>table.style.setProperty('--mobile-column-'+(index+1),String(order.indexOf(key)+1)));
    table.dataset.taskColumn=String(keys.indexOf('task')+1);
    return;
  }
  table.classList.add('mobile-record-table');
  table.setAttribute('role', 'table');
  table.tHead.setAttribute('role', 'rowgroup');
  table.tHead.rows[0].setAttribute('role', 'row');
  for (const header of headers) header.setAttribute('role', 'columnheader');
  for (const body of table.tBodies) {
    body.setAttribute('role', 'rowgroup');
    for (const row of body.rows) {
      row.setAttribute('role', 'row');
      for (const [index, cell] of [...row.cells].entries()) {
        const header = headers[index];
        cell.setAttribute('role', 'cell');
        const label = header ? mobileColumnLabel(header) : '';
        cell.dataset.mobileLabel = label;
        cell.dataset.mobileKey = header?.dataset.column || label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        if (cell.colSpan > 1) cell.dataset.mobileKey = 'full';
        if (!label && cell.querySelector('input[type="checkbox"]')) cell.dataset.mobileKey = 'selection';
      }
    }
  }
}
export function mountMobileLayout(doc = document) {
  const title = doc.querySelector('.page-header h1');
  let scheduled = false;
  const compact = doc.defaultView.matchMedia('(max-width: 700px)');
  const moved = new Map();
  function arrangeHelp() {
    for (const [copy,original] of moved) {
      if (!copy.isConnected) { moved.delete(copy); continue; }
      if (!compact.matches) { original.replaceWith(copy); moved.delete(copy); }
    }
    if (!compact.matches) {
      for (const help of doc.querySelectorAll('[data-mobile-page-help]')) help.remove();
      return;
    }
    for (const copy of doc.querySelectorAll('[data-mobile-help-copy]')) {
      if (moved.has(copy) || copy.closest('[data-mobile-page-help]')) continue;
      const owner = copy.closest('#work-app,.card,.allocation') || copy.parentElement;
      let help = [...owner.children].find(child=>child.hasAttribute('data-mobile-page-help'));
      if (!help) {
        help = doc.createElement('details'); help.className = 'mobile-page-help'; help.dataset.mobilePageHelp = '';
        const label = doc.createElement('summary'); label.textContent = 'Help'; help.append(label); owner.append(help);
      }
      const original = doc.createComment('mobile-help-original'); copy.before(original); moved.set(copy,original); help.append(copy);
    }
  }
  const refresh = () => {
    scheduled = false;
    if (title) title.title = title.textContent;
    arrangeHelp();
    for (const table of doc.querySelectorAll('.page-body table,dialog table')) prepareMobileTable(table);
    arrangeMobileControls(doc, compact.matches);
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    doc.defaultView.requestAnimationFrame(refresh);
  };
  const observer = new doc.defaultView.MutationObserver(schedule);
  observer.observe(doc.body, {childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden','open']});
  doc.defaultView.addEventListener('warehouse:page-loaded', refresh);
  doc.defaultView.addEventListener('resize', schedule);
  doc.addEventListener('warehouse:table-layout', schedule);
  doc.addEventListener('change', schedule);
  doc.fonts?.ready.then(schedule);
  refresh();
  return () => {observer.disconnect();doc.defaultView.removeEventListener('warehouse:page-loaded', refresh);doc.defaultView.removeEventListener('resize', schedule);doc.removeEventListener('warehouse:table-layout', schedule);doc.removeEventListener('change', schedule);};
}
if (typeof document !== 'undefined') mountMobileLayout();
