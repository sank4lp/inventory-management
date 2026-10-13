// Yield between background LED writes so a warehouse-sized display does not block the app.
export function createStocktakeDisplayQueue({logger=null}={}) {
  let jobs=new Map(),timer=null,disposed=false;
  function schedule(){if(!disposed&&!timer&&jobs.size){timer=setTimeout(drain,10);timer.unref?.();}}
  function drain(){
    timer=null;if(disposed)return;
    const [id,job]=jobs.entries().next().value||[];
    if(job){jobs.delete(id);try{job();}catch(error){logger?.warn('stocktaking.display.retry',{error:error.message});}}
    schedule();
  }
  return {
    add(id,job,{priority=false}={}){if(disposed)return;jobs.delete(id);if(priority)jobs=new Map([[id,job],...jobs]);else jobs.set(id,job);schedule();},
    dispose(){disposed=true;if(timer)clearTimeout(timer);timer=null;jobs.clear();},
    get pending(){return jobs.size;}
  };
}
