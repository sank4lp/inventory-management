// Isolated GET-only UI fixture: no inventory or hardware routes.
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {page} from '../src/render.js';
const publicRoot=fileURLToPath(new URL('../public/',import.meta.url));
const fixture=readFileSync(new URL('./notifications-browser-test.html',import.meta.url),'utf8');
createServer((req,res)=>{
 const path=new URL(req.url,'http://localhost').pathname;
 if(req.method!=='GET'){res.writeHead(405);res.end();return;}
 if(path==='/'){res.setHeader('Content-Type','text/html');res.end(page({title:'Notification checks',user:{id:42,name:'Test admin',role:'admin'},content:fixture}));return;}
 if(/^\/(?:client\/[a-z-]+\.js|[a-z-]+\.(?:css|js)|brand\/[a-z-]+\.svg)$/.test(path))try{res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'image/svg+xml');res.end(readFileSync(publicRoot+path.slice(1)));return;}catch{}
 res.writeHead(404);res.end();
}).listen(3242,'127.0.0.1',()=>console.log('Notification UI checks http://localhost:3242/'));
