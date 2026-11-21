import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {initFaq} from './faq.mjs';
import {embedCharacters,initPanels,panelFromDb,panelMessage,validatePresentation,validateRules} from './panels.mjs';

const { DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET } = process.env;
const port = Number(process.env.DASHBOARD_PORT || 4310);
const origin = new URL(process.env.DASHBOARD_ORIGIN || 'http://127.0.0.1:'+port);
if (origin.protocol !== 'https:' && !['127.0.0.1','localhost'].includes(origin.hostname)) throw Error('DASHBOARD_ORIGIN must use HTTPS.');
const db = new DatabaseSync(process.env.DATABASE_PATH || 'tkt.sqlite');
db.exec(`
  PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS settings (guild TEXT PRIMARY KEY, role TEXT NOT NULL, category TEXT NOT NULL, logs TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS guild_locale (guild TEXT PRIMARY KEY, locale TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS ticket_transcripts (id TEXT PRIMARY KEY, channel TEXT NOT NULL UNIQUE, guild TEXT NOT NULL, owner TEXT NOT NULL, html BLOB NOT NULL);
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
const transcriptPath=/^\/transcripts\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const callback=origin.origin+'/auth/callback';
const cookie=(key,value,age)=>key+'='+value+'; Path=/; HttpOnly; SameSite=Lax; Max-Age='+age+(origin.protocol==='https:'?'; Secure':'');
const authReady=Boolean(DISCORD_TOKEN&&DISCORD_CLIENT_ID&&DISCORD_CLIENT_SECRET);
const error=(status,code)=>Object.assign(new Error(code),{status,code});

const publishing=new Set();
async function discord(path,auth,options={}) {
  const response=await fetch('https://discord.com/api/v10'+path,{
    ...options,headers:{...options.headers,Authorization:auth},signal:AbortSignal.timeout(10000)
  });
  if (!response.ok) {
    const result=await response.json().catch(()=>null);
    console.warn('Discord API',options.method||'GET',path.split('?')[0].replace(/[0-9]{17,20}/g,':id'),response.status,result?.code??'');
    throw Object.assign(error(response.status===403||response.status===404?403:502,'discord'),{discordStatus:response.status,discordCode:result?.code});
  }
  return response.status===204?null:response.json();
}
function primaryPanelComponent(components){
  for(const component of components??[]){
    if(component.custom_id?.startsWith('v:open:')||component.custom_id?.startsWith('v:choose:'))return component.custom_id;
    const nested=primaryPanelComponent(component.components);
    if(nested)return nested;
  }
  return null;
}
async function findPreviousPanels(panelId,channel,bot){
  const found=[];
  if(!isId(DISCORD_CLIENT_ID))return found;
  let before='';
  for(let page=0;page<3;page++){
    const messages=await discord('/channels/'+channel+'/messages?limit=100'+(before?'&before='+before:''),bot);
    if(!Array.isArray(messages))break;
    for(const message of messages){
      if(message.author?.id!==DISCORD_CLIENT_ID||!isId(message.id))continue;
      const root=primaryPanelComponent(message.components);
      if(root==='v:open:'+panelId||root==='v:choose:'+panelId||root?.startsWith('v:choose:'+panelId+':'))found.push(message.id);
    }
    if(messages.length<100||!isId(messages.at(-1)?.id))break;
    before=messages.at(-1).id;
  }
  return found;
}
async function input(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw error(415,'invalid');
  let body='';
  for await (const chunk of req) {body+=chunk;if (body.length>48000) throw error(413,'invalid')}
  try { return JSON.parse(body); } catch {throw error(400,'invalid')}
}
function text(value,max,required=false) {
  if (typeof value!=='string' || value.length>max || required&&!value.trim()) throw error(400,'invalid');
  return value.trim();
}
function audit(guild,session,action) {
  db.prepare('INSERT INTO web_audit VALUES(?,?,?,?)').run(guild,session.user.id,action,Date.now());
}
const queueSelect='SELECT t.channel,t.area,t.opened,t.closed,t.owner,t.agent,t.priority,t.rating,t.agent IS NOT NULL AS assigned,s.panel,tr.id AS transcript';
const queueJoins=' FROM tickets t LEFT JOIN ticket_panel_sources s ON s.channel=t.channel LEFT JOIN ticket_transcripts tr ON tr.channel=t.channel AND tr.guild=t.guild';
function filteredQueue(guild,params){
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tickets'").get())return {items:[],total:0};
  const page=Number(params.get('page')||0),limit=Number(params.get('limit')||12);
  if(!Number.isSafeInteger(page)||page<0||page>100000||![8,12,24].includes(limit))throw error(400,'invalid');
  const conditions=['t.guild=?'],args=[guild];
  const add=(condition,value)=>{conditions.push(condition);if(value!==undefined)args.push(value)};
  const state=params.get('state');
  if(state==='open')add('t.closed IS NULL');
  if(state==='closed')add('t.closed IS NOT NULL');
  const priority=params.get('priority');
  if(priority&&['baixa','normal','alta','urgente'].includes(priority))add('t.priority=?',priority);
  const term=(params.get('q')||'').trim().slice(0,100);
  if(term){
    conditions.push('(instr(lower(t.area),lower(?))>0 OR instr(t.channel,?)>0 OR t.owner=?)');
    args.push(term,term,term);
  }
  const panel=params.get('panel');
  if(panel)add('s.panel=?',panel.slice(0,80));
  for(const [key,column] of [['owner','t.owner'],['agent','t.agent']]){
    const id=params.get(key);
    if(id)add(column+'=?',id.slice(0,24));
  }
  const after=params.get('after'),before=params.get('before');
  if(after&&/^\d{4}-\d{2}-\d{2}$/.test(after)&&Number.isFinite(Date.parse(after)))add('t.opened>=?',Date.parse(after));
  if(before&&/^\d{4}-\d{2}-\d{2}$/.test(before)&&Number.isFinite(Date.parse(before)))add('t.opened<?',Date.parse(before)+86400000);
  const where=queueJoins+' WHERE '+conditions.join(' AND ');
  const total=db.prepare('SELECT COUNT(*) AS total'+where).get(...args).total;
  const items=db.prepare(queueSelect+where+' ORDER BY t.opened DESC,t.channel DESC LIMIT ? OFFSET ?').all(...args,limit,page*limit);
  return {total,items};
}
function queue(guild) {
  const exists=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tickets'").get();
  if (!exists) return {totals:{opened:0,closed:0,active:0,rated:0},items:[]};
  return {
    totals:db.prepare('SELECT COUNT(*) opened, COUNT(closed) closed, COUNT(*)-COUNT(closed) active, COUNT(rating) rated FROM tickets WHERE guild=?').get(guild),
    items:db.prepare('SELECT t.channel, t.area, t.opened, t.closed, t.priority, t.rating, t.agent IS NOT NULL AS assigned, tr.id AS transcript FROM tickets t LEFT JOIN ticket_transcripts tr ON tr.channel=t.channel AND tr.guild=t.guild WHERE t.guild=? ORDER BY t.opened DESC LIMIT 100').all(guild)
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
      const next=url.searchParams.get('next')||'';
      states.set(state,{until:Date.now()+300000,next:transcriptPath.test(next)?next:'/'});
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
      return redirect(attempt.next,[cookie('tkt_state','',0),cookie('tkt_session',id,age)]);
    }
    if(method==='POST' && url.pathname==='/auth/logout'){
      sessions.delete(cookies.tkt_session);
      return send(200,{ok:true},{'Set-Cookie':cookie('tkt_session','',0)});
    }
    if(method==='GET' && url.pathname==='/api/session')return send(200,{ready:authReady,user:session?.until>Date.now()?session.user:null});
    if(method==='GET'&&transcriptPath.test(url.pathname)){
      if(!session||session.until<=Date.now())return redirect('/auth/login?next='+encodeURIComponent(url.pathname));
      const id=url.pathname.split('/').at(-1);
      const meta=db.prepare('SELECT guild,owner FROM ticket_transcripts WHERE id=?').get(id);
      if(meta){
        const canRead=meta.owner===session.user.id||
          (await discord('/users/@me/guilds?limit=200',session.bearer)).some(g=>g.id===meta.guild&&manager(g));
        if(canRead){
          const {html}=db.prepare('SELECT html FROM ticket_transcripts WHERE id=?').get(id);
          return send(200,Buffer.from(html),{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"sandbox allow-popups allow-popups-to-escape-sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src https://cdn.discordapp.com https://media.discordapp.net"});
        }
      }
      throw error(404,'invalid');
    }
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
    if(method==='GET'&&action==='queue')return send(200,filteredQueue(guild,url.searchParams));
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
    if(method==='GET'&&!action){
      const hasTickets=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tickets'").get();
      const counts=hasTickets?db.prepare('SELECT s.panel,COUNT(*) AS total FROM ticket_panel_sources s JOIN tickets t ON t.channel=s.channel WHERE t.guild=? AND t.closed IS NULL GROUP BY s.panel').all(guild):[];
      const countsByPanel=new Map(counts.map(row=>[row.panel,row.total]));
      const publications=db.prepare('SELECT x.panel,x.channel,x.message FROM panel_publications x JOIN web_panels p ON p.id=x.panel WHERE p.guild=? ORDER BY length(x.message),x.message').all(guild);
      const publishedByPanel=new Map(publications.map(row=>[row.panel,row]));
      return send(200,{
      settings,locale,channels:channels.filter(c=>[0,4,5].includes(c.type)).map(({id,name,type})=>({id,name,type})),
      roles:roles.filter(r=>r.id!==guild).map(({id,name})=>({id,name})),
      faqs:db.prepare('SELECT id,question,answer,locale,published FROM faq_entries WHERE guild=? ORDER BY question').all(guild),
      panels:db.prepare('SELECT p.id,p.title,p.body,r.rules FROM web_panels p LEFT JOIN panel_rules r ON r.id=p.id WHERE p.guild=? ORDER BY p.title').all(guild).map(p=>({...p,rules:p.rules?JSON.parse(p.rules):{},
        openCount:countsByPanel.get(p.id)??0,publication:publishedByPanel.get(p.id)??null})),queue:queue(guild)
      });
    }
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
        const p=rules.presentation;
        if(p.faqId&&!db.prepare('SELECT 1 FROM faq_entries WHERE id=? AND guild=? AND published=1').get(p.faqId,guild))throw Error('Invalid FAQ');
        if(p.layout==='embed'){
          const size=embedCharacters(p,title,body)+p.extras.reduce((n,item)=>n+embedCharacters(item),0);
          if(size>6000)throw Error('Embed character limit');
        }
      }catch{throw error(400,'panelRulesInvalid')}
      if(rules.logChannel){
        const log=channels.find(channel=>channel.id===rules.logChannel);
        const overwrite=log.permission_overwrites?.find(permission=>permission.id===guild);
        const everyone=BigInt(roles.find(role=>role.id===guild)?.permissions??'0');
        const visibility=((everyone&~BigInt(overwrite?.deny??'0'))|BigInt(overwrite?.allow??'0'))&1024n;
        if(visibility)throw error(400,'privateLogs');
      }
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
    if(action==='deletepanel'){
      const id=text(data.id,80,true);
      if(publishing.has(id))throw error(409,'publishBusy');
      db.exec('BEGIN IMMEDIATE');
      try{
        if(!db.prepare('DELETE FROM web_panels WHERE guild=? AND id=?').run(guild,id).changes)throw error(404,'invalid');
        db.prepare('DELETE FROM panel_rules WHERE id=?').run(id);
        const linked=db.prepare('SELECT r.id,r.rules FROM panel_rules r JOIN web_panels p ON p.id=r.id WHERE p.guild=?').all(guild);
        for(const row of linked){
          const rules=JSON.parse(row.rules);
          if(!rules.presentation?.links?.includes(id))continue;
          rules.presentation.links=rules.presentation.links.filter(link=>link!==id);
          db.prepare('UPDATE panel_rules SET rules=? WHERE id=?').run(JSON.stringify(rules),row.id);
        }
        audit(guild,session,'panel.delete');
        db.exec('COMMIT');
      }catch(e){db.exec('ROLLBACK');throw e}
      return send(200,{ok:true});
    }
    if(action==='publish'){
      if(!settings||!isId(data.channel)||!channels.some(c=>c.id===data.channel&&[0,5].includes(c.type)))throw error(400,'invalid');
      const panel=typeof data.id==='string'&&panelFromDb(db,guild,data.id);
      if(!panel)throw error(404,'invalid');
      if(publishing.has(panel.id))throw error(409,'publishBusy');
      publishing.add(panel.id);
      try{
        const linked=(panel.rules.presentation?.links??[]).map(id=>panelFromDb(db,guild,id)).filter(Boolean);
        let cleanupPending=false;
        const knownChannels=new Set([data.channel,...db.prepare('SELECT DISTINCT channel FROM panel_publications WHERE panel=?').all(panel.id).map(row=>row.channel)]);
        for(const channel of knownChannels){
          try{
            for(const old of await findPreviousPanels(panel.id,channel,bot))
              db.prepare('INSERT OR IGNORE INTO panel_publications VALUES(?,?,?)').run(panel.id,channel,old);
          }catch(e){
            if(e.discordStatus!==404||e.discordCode!==10003)cleanupPending=true;
          }
        }
        const msg=await discord('/channels/'+data.channel+'/messages',bot,{
          method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify(panelMessage(panel,linked,locale))
        });
        db.prepare('INSERT INTO panel_publications VALUES(?,?,?)').run(panel.id,data.channel,msg.id);
        for(const old of db.prepare('SELECT channel,message FROM panel_publications WHERE panel=? AND message<>?').all(panel.id,msg.id)){
          try{
            await discord('/channels/'+old.channel+'/messages/'+old.message,bot,{method:'DELETE'});
          }catch(e){
            if(e.discordStatus!==404||![10003,10008].includes(e.discordCode)){cleanupPending=true;continue}
          }
          db.prepare('DELETE FROM panel_publications WHERE message=?').run(old.message);
        }
        audit(guild,session,'panel.publish');
        return send(200,{ok:true,cleanupPending,url:'https://discord.com/channels/'+guild+'/'+data.channel+'/'+msg.id});
      }finally{publishing.delete(panel.id)}
    }
    throw error(404,'invalid');
  }catch(e){if(e.status>0)return send(e.status,{error:e.code});console.error('Dashboard request failed:',e.name);return send(500,{error:'server'})}
}).listen(port,'127.0.0.1',()=>console.log('TKT Dashboard: '+origin.origin));
