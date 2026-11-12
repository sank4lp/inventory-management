import {escapeHtml as e} from '../render.js';

// Keep interactive pages bounded; exports explicitly opt into the complete data.
export function paginateRows(rows,url,{defaultSize=50,label='Rows',complete=false}={}) {
 const requested=Number(url.searchParams.get('pageSize'));
 const size=[20,50,100].includes(requested)?requested:defaultSize,total=rows.length;
 const pages=Math.max(1,Math.ceil(total/size));
 const page=Math.min(pages,Math.max(1,Math.floor(Number(url.searchParams.get('page')))||1));
 const offset=(page-1)*size;
 const link=n=>{const next=new URL(url);next.searchParams.set('page',String(n));return e(next.pathname+next.search+next.hash);};
 const controls=complete?'':`<nav class="catalog-pagination" aria-label="${e(label)} pages"><span>${total?offset+1:0}–${Math.min(total,offset+size)} of ${total}</span>${page>1?`<a class="ghost-button" href="${link(page-1)}">Previous</a>`:''}<span>Page ${page} of ${pages}</span>${page<pages?`<a class="ghost-button" href="${link(page+1)}">Next</a>`:''}<form method="get" action="${e(url.pathname+url.hash)}" class="inline-form">${[...url.searchParams].filter(([k])=>!['page','pageSize','print'].includes(k)).map(([k,v])=>`<input type="hidden" name="${e(k)}" value="${e(v)}">`).join('')}<label>Items per page<select name="pageSize">${[20,50,100].map(n=>`<option value="${n}"${n===size?' selected':''}>${n}</option>`).join('')}</select></label><button>Apply</button></form></nav>`;
 return {rows:complete?rows:rows.slice(offset,offset+size),total,page,pages,size,controls};
}
