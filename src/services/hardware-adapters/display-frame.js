import {groupChecksum} from './group-protocol.js';

// One shared wire format for utility displays, tasks, counts and future LED features.
// All entries are validated before firmware changes any output. RGB matches the sketch.
const colors={red:'ff0000',green:'00ff00',blue:'0000ff',cyan:'00ffff',magenta:'ff00ff',pink:'ff00ff',purple:'7800ff',amber:'ff7800',yellow:'ffb400',orange:'ff5000',white:'ffffff'};
export function displayEntry(command) {
  const match=/^to ([A-Za-z0-9._:-]+) (text|digit|clear|blink|locate) (\d+)(?: "([^"\r\n]*)" ([a-z0-9#]+) (\d+) (\d+)( once)?| ([a-z0-9#]+) (\d+) (\d+))?$/.exec(command);
  if(!match)return null;
  const [,address,kind,ch,text,color,speed,brightness,once,animationColor,animationBrightness,duration]=match;
  const channel=Number(ch),mode={text:1,digit:2,clear:3,blink:4,locate:5}[kind];
  const rgb=colors[color||animationColor]||(/^#?[a-f0-9]{6}$/.test(color||animationColor||'')?(color||animationColor).replace('#',''):null);
  const value=text??'',level=Number(brightness??animationBrightness??0),scroll=Number(speed??120),timeout=Number(duration??0);
  if(channel<1||channel>64||level<0||level>100||scroll<20||scroll>1000||timeout>300000||
    (mode!==3&&!rgb)||((mode===1||mode===2)&&(text===undefined||value.length>55||!/^[\x20-\x7e]*$/.test(value)))||
    ((mode===4||mode===5)&&(!duration||timeout<1)))throw new Error('LED display values are outside the supported frame limits.');
  const header=Buffer.alloc(14);header[0]=channel;header[1]=mode;header[2]=level;
  Buffer.from(rgb||'000000','hex').copy(header,3);header.writeUInt16BE(scroll,6);header.writeUInt32BE(timeout,8);header[12]=once?1:0;header[13]=value.length;
  return {address,channel,bytes:Buffer.concat([header,Buffer.from(value,'ascii')])};
}
export function displayFrame(address,request,entries) {
  if(!/^[A-Za-z0-9._:-]{1,95}$/.test(address)||!/^([a-f0-9]{16})$/.test(request))throw new Error('Invalid display frame identity.');
  if(!entries.length||entries.length>64||new Set(entries.map(e=>e.channel)).size!==entries.length||entries.some(e=>e.address.toUpperCase()!==address.toUpperCase()))throw new Error('Invalid display frame targets.');
  const data=Buffer.concat([Buffer.from([entries.length]),...entries.map(e=>e.bytes)]).toString('hex');
  const checksum=groupChecksum(`${address.toUpperCase()} display-frame ${request} ${data}`);
  return {command:`to ${address} display-frame ${request} ${data} ${checksum}`,checksum};
}
