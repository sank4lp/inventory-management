for(const form of document.querySelectorAll('[data-recommendation-actuals]')){
 const key='lightguide-recommendation:'+document.body.dataset.accountId+':'+form.elements.recommendation_key.value;
 const status=document.createElement('p');status.setAttribute('role','status');form.append(status);
 let stored;try{stored=JSON.parse(localStorage.getItem(key)||'null');if(stored)for(const element of form.elements){if(stored[element.name]!=null){if(element.type==='checkbox')element.checked=stored[element.name]==='on';else element.value=stored[element.name];}}}catch{status.textContent='Device storage unavailable. Keep a written movement record.';}
 const save=()=>{stored=Object.fromEntries(new FormData(form));localStorage.setItem(key,JSON.stringify(stored));};
 form.addEventListener('input',()=>{try{save();status.textContent='Draft saved on this device; not yet received for review.';}catch{status.textContent='Draft could not be saved. Keep a written movement record.';}});
 form.addEventListener('submit',async event=>{if(event.submitter?.getAttribute('formaction'))return;event.preventDefault();try{save();const response=await fetch(form.action,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body:new URLSearchParams(stored)});const result=await response.json();if(!response.ok)throw new Error(result.error);status.textContent=result.message;localStorage.removeItem(key);form.querySelector('button:not([formaction])').disabled=true;}catch(error){status.textContent=error.message+' Draft retained; retry with the same receipt.';}});
}
