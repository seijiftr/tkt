import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {initFaq} from './faq.mjs';
import {initPanels,panelFromDb,panelMessage,validatePresentation,validateRules} from './panels.mjs';

const { DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET } = process.env;
const port = Number(process.env.DASHBOARD_PORT || 4310);
const origin = new URL(process.env.DASHBOARD_ORIGIN || 'http://127.0.0.1:'+port);
if (origin.protocol !== 'https:' && !['127.0.0.1','localhost'].includes(origin.hostname)) throw Error('DASHBOARD_ORIGIN must use HTTPS.');
const db = new DatabaseSync(process.env.DATABASE_PATH || 'tkt.sqlite');
db.exec(`
  PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS settings (guild TEXT PRIMARY KEY, role TEXT NOT NULL, category TEXT NOT NULL, logs TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS guild_locale (guild TEXT PRIMARY KEY, locale TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS web_audit (guild TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, occurred INTEGER NOT NULL);
`);
initFaq(db);
initPanels(db);
const page = readFileSync(new URL('./dashboard.html',import.meta.url));
const states=new Map(), sessions=new Map();
const timer=setInterval(()=>{for (const map of [states,sessions]) for (const [key,value] of map) if(value.until<Date.now())map.delete(key)},60000);
timer.unref();
const uid=()=>randomBytes(24).toString('hex');
const isId=v=>typeof v==='string' && /^[0-9]{17,20}$/.test(v);
const manager=g=>g.owner || (BigInt(g.permissions ?? '0')&40n)!==0n;
const callback=origin.origin+'/auth/callback';
const cookie=(key,value,age)=>key+'='+value+'; Path=/; HttpOnly; SameSite=Lax; Max-Age='+age+(origin.protocol==='https:'?'; Secure':'');
const authReady=Boolean(DISCORD_TOKEN&&DISCORD_CLIENT_ID&&DISCORD_CLIENT_SECRET);
const error=(status,code)=>Object.assign(new Error(code),{status,code});

async function discord(path,auth,options={}) {
  const response=await fetch('https://discord.com/api/v10'+path,{
    ...options,headers:{...options.headers,Authorization:auth},signal:AbortSignal.timeout(10000)
  });
  if (!response.ok) {
    const result=await response.json().catch(()=>null);
    console.warn('Discord API',options.method||'GET',path.split('?')[0].replace(/[0-9]{17,20}/g,':id'),response.status,result?.code??'');
    throw error(response.status===403||response.status===404?403:502,'discord');
  }
  return response.json();
}
async function input(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw error(415,'invalid');
  let body='';
  for await (const chunk of req) {body+=chunk;if (body.length>16000) throw error(413,'invalid')}
  try { return JSON.parse(body); } catch {throw error(400,'invalid')}
}
function text(value,max,required=false) {
  if (typeof value!=='string' || value.length>max || required&&!value.trim()) throw error(400,'invalid');
  return value.trim();
}
function audit(guild,session,action) {
  db.prepare('INSERT INTO web_audit VALUES(?,?,?,?)').run(guild,session.user.id,action,Date.now());
}
function queue(guild) {
  const exists=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tickets'").get();
  if (!exists) return {totals:{opened:0,closed:0,active:0,rated:0},items:[]};
  return {
    totals:db.prepare('SELECT COUNT(*) opened, COUNT(closed) closed, COUNT(*)-COUNT(closed) active, COUNT(rating) rated FROM tickets WHERE guild=?').get(guild),
    items:db.prepare('SELECT channel, area, opened, closed, priority, rating FROM tickets WHERE guild=? ORDER BY opened DESC LIMIT 100').all(guild)
  };
}
createServer(async(req,res)=>{
  const send=(status,value,headers={})=>{
    res.writeHead(status,{'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Content-Type':'application/json; charset=utf-8',...headers});
    res.end(Buffer.isBuffer(value)?value:JSON.stringify(value));
  };
  const redirect=(location,cookies=[])=>send(303,null,{Location:location,'Set-Cookie':cookies});
  try {
    const url=new URL(req.url,origin.origin);
    const cookies=Object.fromEntries((req.headers.cookie||'').split(/;\s*/).map(p=>p.split('=',2)).filter(x=>x.length===2));
    const method=req.method;
    const session=sessions.get(cookies.tkt_session);
    if (method==='POST' && req.headers.origin!==origin.origin) throw error(403,'forbidden');
    if(method==='GET' && url.pathname==='/') return send(200,page,{'Content-Type':'text/html; charset=utf-8'});
    if(method==='GET' && url.pathname==='/auth/login'){
      if(!authReady) return redirect('/?error=oauth');
      const state=uid();
      states.set(state,{until:Date.now()+300000});
      const params=new URLSearchParams({client_id:DISCORD_CLIENT_ID,redirect_uri:callback,response_type:'code',scope:'identify guilds',state});
      return redirect('https://discord.com/oauth2/authorize?'+params,[cookie('tkt_state',state,300)]);
    }
    if(method==='GET' && url.pathname==='/auth/callback'){
      const failure=(code)=>redirect('/?error='+code,[cookie('tkt_state','',0)]);
      const state=url.searchParams.get('state');
      const attempt=state && state===cookies.tkt_state && states.get(state);
      if(!attempt||attempt.until<Date.now())return failure('oauthExpired');
      states.delete(state);
      const code=url.searchParams.get('code');
      if(!code)return failure('oauthDenied');
      let token,user,bearer;
      try {
        const response=await fetch('https://discord.com/api/v10/oauth2/token',{
          method:'POST',
          headers:{'Content-Type':'application/x-www-form-urlencoded',Authorization:'Basic '+Buffer.from(DISCORD_CLIENT_ID+':'+DISCORD_CLIENT_SECRET).toString('base64')},
          body:new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:callback}),
          signal:AbortSignal.timeout(10000)
        });
        token=await response.json();
        if(!response.ok){
          const message=token.error==='invalid_client'?'oauthClient':token.error==='invalid_grant'?'oauthExpired':'oauthUnavailable';
          return failure(message);
        }
        if(typeof token.access_token!=='string'||!Number.isFinite(token.expires_in)||token.expires_in<=0)return failure('oauthUnavailable');
        bearer='Bearer '+token.access_token;
        user=await discord('/users/@me',bearer);
      }catch{return failure('oauthUnavailable')}
      const id=uid(), age=Math.min(token.expires_in,28800);
      sessions.delete(cookies.tkt_session);
      sessions.set(id,{user:{id:user.id,name:user.global_name||user.username},bearer,until:Date.now()+age*1000});
      return redirect('/',[cookie('tkt_state','',0),cookie('tkt_session',id,age)]);
    }
    if(method==='POST' && url.pathname==='/auth/logout'){
      sessions.delete(cookies.tkt_session);
      return send(200,{ok:true},{'Set-Cookie':cookie('tkt_session','',0)});
    }
    if(method==='GET' && url.pathname==='/api/session')return send(200,{ready:authReady,user:session?.until>Date.now()?session.user:null});
    if(!session||session.until<=Date.now())throw error(401,'login');
    if(!session.guilds || session.guildsUntil<=Date.now()){
      session.guilds=(await discord('/users/@me/guilds?limit=200',session.bearer)).filter(manager);
      session.guildsUntil=Date.now()+30000;
    }
    const guilds=session.guilds;
    if(method==='GET'&&url.pathname==='/api/servers'){
      const eligible=new Set(guilds.map(guild=>guild.id));
      const installed=new Set();
      let after='';
      while(installed.size<eligible.size){
        const path='/users/@me/guilds?limit=200'+(after?'&after='+after:'');
        const page=await discord(path,'Bot '+DISCORD_TOKEN);
        for(const item of page)if(eligible.has(item.id))installed.add(item.id);
        if(page.length<200)break;
        const next=page.at(-1).id;
        if(next===after)break;
        after=next;
      }
      return send(200,guilds.filter(guild=>installed.has(guild.id)).map(({id,name})=>({id,name})));
    }
    const route=url.pathname.match(/^\/api\/servers\/([0-9]{17,20})(?:\/([a-z]+))?$/);
    if(!route)throw error(404,'invalid');
    const [,guild,action]=route;
    if(!guilds.some(item=>item.id===guild))throw error(403,'forbidden');
    const bot='Bot '+DISCORD_TOKEN;
    const [channels,roles]=await Promise.all([discord('/guilds/'+guild+'/channels',bot),discord('/guilds/'+guild+'/roles',bot)]);
    const settings=db.prepare('SELECT role,category,logs FROM settings WHERE guild=?').get(guild)??null;
    const locale=db.prepare('SELECT locale FROM guild_locale WHERE guild=?').get(guild)?.locale??'pt-BR';
    if(method==='GET'&&action==='analytics'){
      const days=Number(url.searchParams.get('days')||7);
      if(![7,14,30].includes(days))throw error(400,'invalid');
      const day=86400000, start=Math.floor(Date.now()/day)*day-(days-1)*day;
      const report=Array.from({length:days},(_,i)=>({d:new Date(start+i*day).toISOString().slice(0,10),a:0,b:0}));
      const have=name=>Boolean(db.prepare('SELECT 1 FROM sqlite_master WHERE type=? AND name=?').get('table',name));
      const events=have('ticket_events');
      const latencies={claim:null,reply:null};
      const demand=Array.from({length:7},()=>Array(24).fill(0));
      const ages=[0,0,0,0];
      let eligible=0,reopened=0;
      const now=Date.now();
      if(have('tickets')){
        const cohort=db.prepare('SELECT opened,closed FROM tickets WHERE guild=? AND (opened>=? OR closed IS NULL)').iterate(guild,start);
        for(const item of cohort){
          const when=new Date(item.opened);
          if(item.opened>=start&&item.opened<=now)demand[(when.getUTCDay()+6)%7][when.getUTCHours()]++;
          if(item.closed===null){const hours=(now-item.opened)/3600000;ages[hours<1?0:hours<8?1:hours<24?2:3]++;}
        }
        for(const row of db.prepare('SELECT opened,closed FROM tickets WHERE guild=? AND (opened>=? OR closed>=?)').iterate(guild,start,start)){
          const opened=report[Math.floor((row.opened-start)/day)];if(opened)opened.a++;
          if(!events && row.closed!==null){const closed=report[Math.floor((row.closed-start)/day)];if(closed)closed.b++}
        }
        if(events){
          const cohort=db.prepare("SELECT COUNT(DISTINCT channel) closed, COUNT(DISTINCT CASE WHEN EXISTS (SELECT 1 FROM ticket_events r WHERE r.guild=c.guild AND r.channel=c.channel AND r.kind='reopen' AND r.time>=c.time AND r.time<=?) THEN channel END) reopened FROM ticket_events c WHERE guild=? AND kind='close' AND time BETWEEN ? AND ?").get(now,guild,start,now);
          eligible=cohort.closed;
          reopened=cohort.reopened;
          const closes=db.prepare(
            "SELECT time FROM ticket_events WHERE guild=? AND kind='close' AND time>=? "+
            "UNION ALL SELECT closed FROM tickets t WHERE guild=? AND closed>=? "+
            "AND NOT EXISTS (SELECT 1 FROM ticket_events e WHERE e.guild=t.guild AND e.channel=t.channel AND e.kind='close' AND e.time=t.closed)"
          );
          for(const row of closes.iterate(guild,start,guild,start)){const closed=report[Math.floor((row.time-start)/day)];if(closed)closed.b++}
          for(const kind of ['claim','reply']){
            const values=db.prepare("SELECT MIN(e.time)-t.opened duration FROM ticket_events e JOIN tickets t ON t.channel=e.channel AND t.guild=e.guild WHERE e.guild=? AND e.kind=? AND t.opened>=? AND e.time>=t.opened GROUP BY e.channel ORDER BY duration").all(guild,kind,start).map(r=>r.duration);
            if(values.length){
              const middle=Math.floor(values.length/2);
              latencies[kind]={median:values.length%2?values[middle]:(values[middle-1]+values[middle])/2,p90:values[Math.ceil(values.length*.9)-1],count:values.length};
            }
          }
        }
      }
      return send(200,{report,latencies,demand,ages,reopened,eligible});
    }
    if(method==='GET'&&!action)return send(200,{
      settings,locale,channels:channels.filter(c=>[0,4,5].includes(c.type)).map(({id,name,type})=>({id,name,type})),
      roles:roles.filter(r=>r.id!==guild).map(({id,name})=>({id,name})),
      faqs:db.prepare('SELECT id,question,answer,locale,published FROM faq_entries WHERE guild=? ORDER BY question').all(guild),
      panels:db.prepare('SELECT p.id,p.title,p.body,r.rules FROM web_panels p LEFT JOIN panel_rules r ON r.id=p.id WHERE p.guild=? ORDER BY p.title').all(guild).map(p=>({...p,rules:p.rules?JSON.parse(p.rules):{}})),queue:queue(guild)
    });
    if(method!=='POST')throw error(405,'invalid');
    const data=await input(req);
    if(!data||typeof data!=='object'||Array.isArray(data))throw error(400,'invalid');
    if(action==='settings'){
      if(!roles.some(r=>r.id===data.role&&r.id!==guild)||!channels.some(c=>c.id===data.category&&c.type===4)||!channels.some(c=>c.id===data.logs&&c.type===0)||!['en','pt-BR'].includes(data.locale))throw error(400,'invalid');
      const everyone=roles.find(r=>r.id===guild);
      const log=channels.find(c=>c.id===data.logs);
      const overwrite=log.permission_overwrites?.find(p=>p.id===guild);
      const visibility=(((BigInt(everyone?.permissions??0)&~BigInt(overwrite?.deny??0))|BigInt(overwrite?.allow??0))&1024n)!==0n;
      if(visibility)throw error(400,'privateLogs');
      db.exec('BEGIN');
      try{
        db.prepare('INSERT INTO settings VALUES(?,?,?,?) ON CONFLICT(guild) DO UPDATE SET role=excluded.role,category=excluded.category,logs=excluded.logs').run(guild,data.role,data.category,data.logs);
        db.prepare('INSERT INTO guild_locale VALUES(?,?) ON CONFLICT(guild) DO UPDATE SET locale=excluded.locale').run(guild,data.locale);
        audit(guild,session,'settings.save');
        db.exec('COMMIT');
      }catch(e){db.exec('ROLLBACK');throw e}
      return send(200,{ok:true});
    }
    if(action==='faq'){
      const question=text(data.question,150,true),answer=text(data.answer,1500,true);
      if(!['pt-BR','en'].includes(data.locale)||typeof data.published!=='boolean'||typeof data.id!=='string')throw error(400,'invalid');
      const values=[question,answer,data.locale,Number(data.published)];
      db.exec('BEGIN');
      try{
        if(data.id){
          const changed=db.prepare('UPDATE faq_entries SET question=?,answer=?,locale=?,published=? WHERE guild=? AND id=?').run(...values,guild,data.id);
          if(!changed.changes)throw error(404,'invalid');
        }else db.prepare('INSERT INTO faq_entries VALUES(?,?,?,?,?,?)').run(uid(),guild,...values);
        audit(guild,session,'faq.save');
        db.exec('COMMIT');
      }catch(e){db.exec('ROLLBACK');throw e}
      return send(200,{ok:true});
    }
    if(action==='panel'){
      const title=text(data.title,80,true),body=text(data.body,1000,true);
      if(data.id!==undefined&&typeof data.id!=='string')throw error(400,'invalid');
      let rules;
      try{
        rules=validateRules(data.rules,roles.filter(r=>r.id!==guild),channels);
        const available=db.prepare('SELECT id FROM web_panels WHERE guild=?').all(guild).map(row=>row.id);
        rules.presentation=validatePresentation(data.rules?.presentation,available,data.id);
      }catch{throw error(400,'panelRulesInvalid')}
      const id=data.id||uid();
      db.exec('BEGIN');
      try {
        if(data.id){
          if(!db.prepare('UPDATE web_panels SET title=?,body=? WHERE guild=? AND id=?').run(title,body,guild,id).changes)throw error(404,'invalid');
        }else db.prepare('INSERT INTO web_panels VALUES(?,?,?,?)').run(id,guild,title,body);
        db.prepare('INSERT INTO panel_rules VALUES(?,?) ON CONFLICT(id) DO UPDATE SET rules=excluded.rules').run(id,JSON.stringify(rules));
        audit(guild,session,'panel.save');
        db.exec('COMMIT');
      }catch(e){db.exec('ROLLBACK');throw e}
      return send(200,{ok:true,id});
    }
    if(action==='publish'){
      if(!settings||!isId(data.channel)||!channels.some(c=>c.id===data.channel&&[0,5].includes(c.type)))throw error(400,'invalid');
      const panel=typeof data.id==='string'&&panelFromDb(db,guild,data.id);
      if(!panel)throw error(404,'invalid');
      const linked=(panel.rules.presentation?.links??[]).map(id=>panelFromDb(db,guild,id)).filter(Boolean);
      const msg=await discord('/channels/'+data.channel+'/messages',bot,{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify(panelMessage(panel,linked,locale))
      });
      audit(guild,session,'panel.publish');
      return send(200,{ok:true,url:'https://discord.com/channels/'+guild+'/'+data.channel+'/'+msg.id});
    }
    throw error(404,'invalid');
  }catch(e){if(e.status>0)return send(e.status,{error:e.code});console.error('Dashboard request failed:',e.name);return send(500,{error:'server'})}
}).listen(port,'127.0.0.1',()=>console.log('TKT Dashboard: '+origin.origin));
