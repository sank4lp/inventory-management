import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Older distro Caddy builds treat --config - as a literal filename. A private
// temporary file works on those builds and keeps preflight out of /etc.
export function adaptLanConfig(config,{caddy='/usr/bin/caddy',tempRoot=tmpdir(),execute=execFileSync}={}) {
  const dir=mkdtempSync(join(tempRoot,'lightguide-lan-check-'));
  try {
    const path=join(dir,'Caddyfile');
    writeFileSync(path,config,{mode:0o600,flag:'wx'});
    return execute(caddy,['adapt','--adapter','caddyfile','--config',path],{
      encoding:'utf8',timeout:20000,stdio:['ignore','pipe','pipe'],
    }).trim();
  }catch(error){
    throw new Error(`${caddy} failed: ${String(error.stderr||error.message).trim()}`,{cause:error});
  }finally{
    rmSync(dir,{recursive:true,force:true});
  }
}
