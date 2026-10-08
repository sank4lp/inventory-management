// Reserve label space before a toggle starts, rather than resizing its neighbours.
const knownPairs=[['Save','Saving…'],['Save Details','Saving…'],['Assign Task','Waiting for warehouse confirmation'],['Select','Done'],['Show More','Show Less'],['Show module','Hide module'],['Menu','Close menu']];
export function buttonLabels(text,data={},flags={}) {
 text=String(text||'');
 const labels=new Set([String(text||'').trim(),data.showLabel,data.activeLabel,data.loadingLabel,data.ledLoadingLabel,...String(data.stableLabels||'').split('|')].filter(Boolean));
 for(const pair of knownPairs)if(pair.includes(text.trim()))pair.forEach(label=>labels.add(label));
 if(flags.ping)['Ping','Pinging','Clearing','Failed'].forEach(label=>labels.add(label));
 if(flags.locate)['Locate','Locating','Clearing','Failed'].forEach(label=>labels.add(label));
 if(flags.quantity){labels.add(data.showLabel||'Show Quantity');labels.add(data.activeLabel||'Showing Quantity');['Showing','Clearing','Failed'].forEach(label=>labels.add(label));}
 if(/^Discard All \(/.test(text))labels.add('Discard All (100)');
 return [...labels];
}

const records=new WeakMap(), measurements=new Map();
let probe;
function measure(doc,styles,text,width=null) {
 const key=JSON.stringify([styles.font,styles.letterSpacing,styles.textTransform,text,width]);
 if(measurements.has(key))return measurements.get(key);
 if(!probe||probe.ownerDocument!==doc){probe=doc.createElement('span');probe.setAttribute('aria-hidden','true');probe.style.cssText='position:fixed;left:-10000px;top:0;visibility:hidden;pointer-events:none;display:inline-block;';doc.body.append(probe);}
 probe.style.font=styles.font;probe.style.letterSpacing=styles.letterSpacing;probe.style.textTransform=styles.textTransform;
 probe.style.width=width===null?'auto':width+'px';probe.style.whiteSpace=width===null?'pre':'normal';probe.textContent=text;
 const bounds=probe.getBoundingClientRect(),result={width:bounds.width,height:bounds.height};measurements.set(key,result);return result;
}
export function reserveButtonSize(button,extraLabels=[]) {
 if(!button?.ownerDocument||!button.isConnected||button.matches('.searchable-toggle,.combo-toggle,.icon-button,.notification-close,.global-notifications-button,[data-remove-actual],.row-collapse-icon-button'))return;
 const text=button.textContent.trim(),data=button.dataset;
 const flags={ping:button.matches('[data-ping-cell],[data-ping-controller]'),locate:button.matches('[data-locate-cell],[data-adjustment-locate-cell]'),quantity:button.matches('[data-show-product-quantity],[data-show-location-count]')};
 const pendingLabels=[data.loadingLabel,data.ledLoadingLabel,button.closest('form[data-led-command-form]')?.dataset.ledLoadingLabel,...extraLabels];
 if(flags.ping)pendingLabels.push('Pinging','Clearing');
 if(flags.locate)pendingLabels.push('Locating','Clearing');
 if(flags.quantity)pendingLabels.push('Showing','Clearing');
 if(button.matches('[data-controller-health-submit]'))pendingLabels.push('Checking');
 const labels=buttonLabels(text,data,flags);
 const record=records.get(button)||{labels:new Set(),busyLabels:new Set(),first:text};
 pendingLabels.filter(Boolean).forEach(label=>{record.busyLabels.add(label);record.labels.add(label);});
 [...labels,...extraLabels,record.first].filter(Boolean).forEach(label=>record.labels.add(label));records.set(button,record);
 if(record.labels.size<2)return;
 const doc=button.ownerDocument,styles=doc.defaultView.getComputedStyle(button),number=value=>Number.parseFloat(value)||0;
 const horizontal=number(styles.paddingLeft)+number(styles.paddingRight)+number(styles.borderLeftWidth)+number(styles.borderRightWidth);
 const vertical=number(styles.paddingTop)+number(styles.paddingBottom)+number(styles.borderTopWidth)+number(styles.borderBottomWidth);
 const icon=button.querySelector('svg,.button-icon'),iconWidth=icon?icon.getBoundingClientRect().width+8:0;
 const parentWidth=button.parentElement?.clientWidth||doc.documentElement.clientWidth;
 let width=0,height=44;
 for(const label of record.labels){
  const size=measure(doc,styles,label);width=Math.max(width,size.width+horizontal+iconWidth);
  // The longest state may wrap on small phones; reserve that height too.
  if(parentWidth>horizontal)height=Math.max(height,measure(doc,styles,label,Math.max(1,parentWidth-horizontal-iconWidth)).height+vertical);
 }
 for(const label of record.busyLabels){
  width=Math.max(width,measure(doc,styles,label).width+horizontal+24);
  if(parentWidth>horizontal+24)height=Math.max(height,measure(doc,styles,label,parentWidth-horizontal-24).height+vertical);
 }
 const set=(key,value)=>{const next=Math.ceil(value)+'px';if(button.style.getPropertyValue(key)!==next)button.style.setProperty(key,next);};
 set('--stable-button-width',width);set('--stable-button-height',height);button.dataset.stableButtonSize='';
}

export function installStableButtons(doc=document) {
 const scan=node=>{
  const element=node.nodeType===1?node:node.parentElement;
  const owner=element?.closest('button');if(owner)reserveButtonSize(owner);
  for(const button of element?.querySelectorAll?.('button')||[])reserveButtonSize(button);
 };
 const observer=new doc.defaultView.MutationObserver(changes=>{
  const nodes=new Set();for(const change of changes){nodes.add(change.target);for(const node of change.addedNodes||[])nodes.add(node);}
  for(const node of nodes)scan(node);
 });
 observer.observe(doc.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['hidden','open','data-show-label','data-active-label','data-loading-label','data-led-loading-label','data-stable-labels']});
 const refresh=()=>scan(doc.body);doc.defaultView.addEventListener('resize',refresh);refresh();doc.fonts?.ready.then(refresh);
 return ()=>{observer.disconnect();doc.defaultView.removeEventListener('resize',refresh);};
}
if(typeof document!=='undefined'){
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>installStableButtons(document),{once:true});
 else installStableButtons(document);
}
