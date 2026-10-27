// Yield once, then commit queued background displays together per controller.
export function createStocktakeDisplayQueue({logger=null,batch=callback=>callback()}={}) {
  let jobs=new Map(),timer=null,disposed=false;
  function schedule(){if(!disposed&&!timer&&jobs.size){timer=setTimeout(drain,0);timer.unref?.();}}
  function drain(){
    timer=null;if(disposed)return;
    const pending=[...jobs.values()];jobs.clear();
    try{batch(()=>{for(const job of pending)try{job();}catch(error){logger?.warn('stocktaking.display.retry',{error:error.message});}});}catch(error){logger?.warn('stocktaking.display.retry',{error:error.message});}
    schedule();
  }
  return {
    add(id,job,{priority=false}={}){if(disposed)return;jobs.delete(id);if(priority)jobs=new Map([[id,job],...jobs]);else jobs.set(id,job);schedule();},
    dispose(){disposed=true;if(timer)clearTimeout(timer);timer=null;jobs.clear();},
    get pending(){return jobs.size;}
  };
}
