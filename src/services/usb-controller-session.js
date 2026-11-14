import {openSync,closeSync,readSync,writeSync,constants} from 'node:fs';
import {setTimeout as wait} from 'node:timers/promises';

// One session owns the selected ESP32's USB port during maintenance, never the RS485 adapter.
export function openUsbControllerSession(port,host,{io={openSync,closeSync,readSync,writeSync},waitFor=wait,now=Date.now,bootWaitMs=1500}={}) {
  const configured=host.configureSerial(port);
  if (configured.status!==0)throw new Error('Could not configure the ESP32 USB port.');
  const fd=io.openSync(port,constants.O_RDWR|constants.O_NOCTTY|constants.O_NONBLOCK);
  let closed=false,buffer='',ready=false;
  function receive(){
    const bytes=Buffer.alloc(2048);
    try {const length=io.readSync(fd,bytes,0,bytes.length,null);if(length)buffer+=bytes.subarray(0,length).toString('utf8');}
    catch(error){if(!['EAGAIN','EWOULDBLOCK'].includes(error.code))throw error;}
    if(buffer.length>8192)throw new Error('Invalid controller USB response.');
    const lines=buffer.split('\n');buffer=lines.pop();return lines.flatMap(line=>{try{return [JSON.parse(line.trim())];}catch{return [];}});
  }
  return {
    async exchange(command,accept,{attempts=6,timeoutMs=1000}={}) {
      if(closed)throw new Error('Controller USB session closed.');
      if(!/^to [A-Za-z0-9._:-]+ (config-status|configure) /.test(command) || command.length>=320 || /[\r\n]/.test(command))throw new Error('Invalid USB maintenance command.');
      if(!Number.isInteger(attempts)||attempts<1||attempts>20||!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new Error('Invalid USB response timeout.');
      // ROM identity reads and uploads reset the ESP32. Do not consume the
      // entire confirmation budget while the application firmware is booting.
      if(!ready){await waitFor(bootWaitMs);ready=true;}
      receive();buffer='';
      for(let attempt=0;attempt<attempts;attempt++) {
        const bytes=Buffer.from(command+'\n');let offset=0;
        const deadline=now()+timeoutMs;
        while(offset<bytes.length && now()<deadline) {
          try {offset+=io.writeSync(fd,bytes,offset,bytes.length-offset,null);}catch(error){if(!['EAGAIN','EWOULDBLOCK'].includes(error.code))throw error;}
          if(offset<bytes.length)await waitFor(20);
        }
        if(offset<bytes.length)throw new Error('Incomplete USB write. Read the controller configuration before retrying.');
        while(now()<deadline) {
          if(closed)throw new Error('Controller USB session closed.');
          for(const reply of receive()){
            if(reply.type==='error')throw new Error(`ESP32 rejected the configuration: ${reply.message || 'unknown error'}.`);
            if(accept(reply))return reply;
          }
          await waitFor(20);
        }
      }
      throw new Error('Controller USB confirmation timed out. Configuration may have been applied; read it back before retrying.');
    },
    close(){if(!closed){closed=true;io.closeSync(fd);}},
  };
}
