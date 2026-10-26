import {openSync,closeSync,readSync,writeSync,constants} from 'node:fs';
import {setTimeout as wait} from 'node:timers/promises';

// One session owns the selected ESP32's USB port during maintenance, never the RS485 adapter.
export function openUsbControllerSession(port,host) {
  const configured=host.configureSerial(port);
  if (configured.status!==0)throw new Error('Could not configure the ESP32 USB port.');
  const fd=openSync(port,constants.O_RDWR|constants.O_NOCTTY|constants.O_NONBLOCK);
  let closed=false,buffer='';
  function receive(){
    const bytes=Buffer.alloc(2048);
    try {const length=readSync(fd,bytes,0,bytes.length,null);if(length)buffer+=bytes.subarray(0,length).toString('utf8');}
    catch(error){if(!['EAGAIN','EWOULDBLOCK'].includes(error.code))throw error;}
    if(buffer.length>8192)throw new Error('Invalid controller USB response.');
    const lines=buffer.split('\n');buffer=lines.pop();return lines.flatMap(line=>{try{return [JSON.parse(line.trim())];}catch{return [];}});
  }
  return {
    async exchange(command,accept,{attempts=4,timeoutMs=700}={}) {
      if(closed)throw new Error('Controller USB session closed.');
      if(!/^to [A-Za-z0-9._:-]+ (config-status|configure) /.test(command) || command.length>=320 || /[\r\n]/.test(command))throw new Error('Invalid USB maintenance command.');
      receive();buffer='';
      for(let attempt=0;attempt<attempts;attempt++) {
        const bytes=Buffer.from(command+'\n');let offset=0;
        const deadline=Date.now()+timeoutMs;
        while(offset<bytes.length && Date.now()<deadline) {
          try {offset+=writeSync(fd,bytes,offset,bytes.length-offset,null);}catch(error){if(!['EAGAIN','EWOULDBLOCK'].includes(error.code))throw error;}
          if(offset<bytes.length)await wait(20);
        }
        if(offset<bytes.length)throw new Error('Incomplete USB write. Read the controller configuration before retrying.');
        while(Date.now()<deadline) {
          for(const reply of receive())if(accept(reply))return reply;
          await wait(20);
        }
      }
      throw new Error('Controller USB confirmation timed out. Configuration may have been applied; read it back before retrying.');
    },
    close(){if(!closed){closed=true;closeSync(fd);}},
  };
}
