const keys={pickMinutes:'default_pick_assignment_minutes',putMinutes:'default_put_assignment_minutes',stocktakeDays:'default_stocktake_due_days'};
const metadata=(db,key)=>db.prepare('SELECT value FROM app_metadata WHERE key=?').get(key)?.value;
export function readDeadlineDefaults(db) {
 const duration=key=>{const n=Number(metadata(db,key));return Number.isFinite(n)&&n>=1&&n<=525600?n:480;};
 const days=Number(metadata(db,keys.stocktakeDays));
 return {pickMinutes:duration(keys.pickMinutes),putMinutes:duration(keys.putMinutes),stocktakeDays:Number.isInteger(days)&&days>=1&&days<=365?days:null};
}
export function deadlineDefaultsPatch(input,{stocktakeAllowed=false}={}) {
 const patch={};
 for(const direction of ['pick','put']){
  const value=input[direction+'DueDuration'],unit=input[direction+'DueUnit'];
  if(value===undefined&&unit===undefined)continue;
  const factor={minutes:1,hours:60,days:1440}[unit],minutes=Number(value)*factor;
  if(!['number','string'].includes(typeof value)||!String(value).trim()||!factor||!Number.isFinite(minutes)||minutes<1||minutes>525600)throw new Error('Choose a '+direction+' default from 1 minute to 365 days.');
  patch[direction+'Minutes']=minutes;
 }
 if(input.stocktakeDueEnabled!==undefined||input.stocktakeDueDays!==undefined){
  if(!stocktakeAllowed)throw new Error('Stocktake manager access is required to change the stocktake deadline default.');
  if(![true,false,'true','false'].includes(input.stocktakeDueEnabled))throw new Error('Choose whether stocktakes have a default deadline.');
  const enabled=input.stocktakeDueEnabled===true||input.stocktakeDueEnabled==='true',days=Number(input.stocktakeDueDays);
  if(enabled&&(!['number','string'].includes(typeof input.stocktakeDueDays)||!String(input.stocktakeDueDays).trim()||!Number.isInteger(days)||days<1||days>365))throw new Error('Choose a stocktake default from 1 to 365 whole days.');
  patch.stocktakeDays=enabled?days:null;
 }
 return patch;
}
export function writeDeadlineDefaults(db,patch,at) {
 for(const [field,value] of Object.entries(patch))db.prepare('INSERT INTO app_metadata(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(keys[field],value===null?'disabled':String(value),at);
}
export function stocktakeDefaultDueDate(db,at,timezone) {
 const days=readDeadlineDefaults(db).stocktakeDays;if(days===null)return null;
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(at),value=type=>Number(parts.find(p=>p.type===type).value);
 return new Date(Date.UTC(value('year'),value('month')-1,value('day')+days)).toISOString().slice(0,10);
}
