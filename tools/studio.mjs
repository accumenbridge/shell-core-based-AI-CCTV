/** Opt-in loopback builder. Offline OPEN_PLATFORM.html has NONE of these privileges. */
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { StudioManager } from './studio-manager.mjs';
import { composeDraft } from './studio-catalogue.mjs';
const ROOT=fileURLToPath(new URL('../',import.meta.url));
export async function createStudio({root=ROOT,port=4390,stateRoot,quiet=false,pairingCode=randomBytes(24).toString('base64url')}={}) {
    if(process.env.NODE_ENV==='production')throw Error('Studio is a loopback developer tool, not production');
    if(!Number.isInteger(port)||port<0||port>65535)throw Error('Invalid Studio port');
    const manager=new StudioManager(root,stateRoot),sessions=new Map();if(quiet)manager.launchStdio='ignore';let origin;let attempts=0,reset=Date.now()+60000;
    const server=createServer({maxHeaderSize:16384},async(req,res)=>{
        res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cross-Origin-Resource-Policy','same-origin');
        const send=(code,v)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(v));};
        const body=async()=>{if(req.headers['content-type']?.split(';')[0]!=='application/json')throw Error('JSON required');let size=0,parts=[];for await(const p of req){size+=p.length;if(size>65536)throw Error('Request exceeds budget');parts.push(p);}return JSON.parse(Buffer.concat(parts).toString('utf8'));};
        try{
            if(req.headers.host!==new URL(origin).host)return send(403,{error:'Unexpected host'});
            if(!['GET','POST'].includes(req.method))return send(405,{error:'Unsupported method'});
            if((req.url?.length??0)>2048)return send(400,{error:'URL exceeds budget'});
            const url=new URL(req.url,origin);
            if(url.search)return send(400,{error:'Query parameters are not accepted'});
            if((req.method==='POST'||req.headers.origin!==undefined)&&req.headers.origin!==origin)return send(403,{error:'Same-origin mutation required'});
            if(req.method==='GET'&&['/','/OPEN_PLATFORM.html','/DOCUMENTATION.html'].includes(url.pathname)){
                const nonce=randomBytes(18).toString('base64url');
                let html=await readFile(join(root,url.pathname==='/DOCUMENTATION.html'?'DOCUMENTATION.html':'OPEN_PLATFORM.html'),'utf8');
                if(url.pathname!=='/DOCUMENTATION.html')html=html.replace('<script>',`<script>globalThis.QB_STUDIO_MODE=true;</script><script>`);
                html=html.replaceAll('<script>',`<script nonce="${nonce}">`);
                res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
                res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html);return;
            }
            if(req.method==='POST'&&url.pathname==='/studio-api/session'){
                if(Date.now()>reset){reset=Date.now()+60000;attempts=0;}
                if(++attempts>10)return send(429,{error:'Wait one minute before trying again'});
                const b=await body();const supplied=typeof b.code==='string'?Buffer.from(b.code):Buffer.alloc(0),expected=Buffer.from(pairingCode);
                if(Object.keys(b).length!==1||supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return send(401,{error:'Invalid pairing code'});
                const token=randomBytes(32).toString('base64url');
                for(const [t,exp] of sessions)if(exp<=Date.now())sessions.delete(t);
                if(sessions.size>=8)sessions.delete(sessions.keys().next().value);
                sessions.set(token,Date.now()+3600000);
                res.setHeader('Set-Cookie',`qb_studio=${token}; HttpOnly; SameSite=Strict; Path=/studio-api; Max-Age=3600`);return send(200,{connected:true});
            }
            const token=(req.headers.cookie??'').split(';').map(s=>s.trim()).find(s=>s.startsWith('qb_studio='))?.slice(10);
            if(!token||(sessions.get(token)??0)<Date.now())return send(401,{error:'Pair this browser using the code printed in the terminal'});
            if(req.method==='POST'&&url.pathname==='/studio-api/logout'){sessions.delete(token);res.setHeader('Set-Cookie','qb_studio=; HttpOnly; SameSite=Strict; Path=/studio-api; Max-Age=0');return send(200,{connected:false});}
            if(req.method==='GET'&&url.pathname==='/studio-api/catalogue')return send(200,await manager.catalogue());
            if(req.method==='GET'&&url.pathname==='/studio-api/status')return send(200,manager.status());
            if(req.method==='POST'&&url.pathname==='/studio-api/preview'){const c=await manager.catalogue();return send(200,composeDraft(await body(),c.modules,c.solutions,c.sourceVersion));}
            if(req.method==='POST'&&url.pathname==='/studio-api/products')return send(201,await manager.save(await body()));
            const op=/^\/studio-api\/products\/([a-z][a-z0-9-]{1,47})\/(build|launch|stop)$/.exec(url.pathname);
            if(req.method==='POST'&&op){const b=await body();if(b.confirm!==true||Object.keys(b).length!==1)return send(400,{error:'Explicit confirmation is required'});
                if(op[2]==='build')return send(202,manager.build(op[1]));
                if(op[2]==='launch')return send(200,await manager.launch(op[1]));
                return send(200,await manager.stop(op[1]));
            }
            return send(404,{error:'No such Studio operation'});
        }catch(e){send(e.code==='EEXIST'?409:400,{error:e.code==='EEXIST'?'Product already exists. No source was overwritten.':e.message});}
    });
    server.requestTimeout=20000;server.headersTimeout=15000;
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});origin=`http://127.0.0.1:${server.address().port}`;
    return {url:origin,code:pairingCode,manager,server,async close(){await manager.close();server.closeAllConnections();await new Promise(r=>server.close(r));}};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
    const i=process.argv.indexOf('--port');const studio=await createStudio({port:i<0?4390:Number(process.argv[i+1])});
    console.log(`\nQuadbridge Product Studio\n${studio.url}\nPairing code (local developer access): ${studio.code}\nThis tool may create product definitions and run fixed build/launch commands after confirmation.\nIt does not install packages, edit existing products, receive shell commands or grant production access.\nCtrl+C stops only this Studio's managed processes.\n`);
    let closing=false;for(const event of ['SIGINT','SIGTERM'])process.on(event,()=>{if(!closing){closing=true;void studio.close().then(()=>process.exit());}});
}
