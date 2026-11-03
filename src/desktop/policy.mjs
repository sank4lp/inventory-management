export function desktopTarget(value,{setup=false}={}){
  try{const url=new URL(value);if(url.protocol!=='http:'||url.hostname!=='localhost'||url.username||url.password||!/^\d+$/.test(url.port)||Number(url.port)<1||Number(url.port)>65535)throw Error();
    if(setup){if(url.port!=='3311'||url.pathname!=='/'||url.search||!/^#[a-f0-9]{64}$/.test(url.hash))throw Error();}
    else if(url.pathname!=='/work'||url.search||url.hash)throw Error();
    return url;
  }catch{throw new Error('Invalid local LytGuide address.');}
}
export function originMatches(value,origin){try{const url=new URL(value);return !url.username&&!url.password&&url.origin===origin&&['http:','https:'].includes(url.protocol);}catch{return false;}}
export function allowedRequest(value,origin){try{const url=new URL(value);if(['blob:','data:','devtools:'].includes(url.protocol))return ['blob:','data:'].includes(url.protocol);if(url.protocol==='ws:')url.protocol='http:';return originMatches(url.href,origin);}catch{return false;}}
export function externalLink(value){try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.href:null;}catch{return null;}}
export function mediaAllowed(origin,requestingUrl,permission,details={}){
  return permission==='media'&&originMatches(requestingUrl,origin)&&Array.isArray(details.mediaTypes)&&details.mediaTypes.length>0&&details.mediaTypes.every(type=>type==='video');
}
export function windowPreferences(partition){return {partition,nodeIntegration:false,nodeIntegrationInWorker:false,nodeIntegrationInSubFrames:false,contextIsolation:true,sandbox:true,webSecurity:true,webviewTag:false,allowRunningInsecureContent:false};}
export function launchMode(args){const modes=args.filter(arg=>/^--lytguide-/.test(arg));if(modes.some(arg=>!['--lytguide-work','--lytguide-setup','--lytguide-resume'].includes(arg))||modes.length>1)throw new Error('Unknown LytGuide launch option.');return modes[0]?.slice('--lytguide-'.length)||'work';}
