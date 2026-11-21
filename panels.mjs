import { createHash } from 'node:crypto';

export function initPanels(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS web_panels (id TEXT PRIMARY KEY, guild TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS panel_rules (id TEXT PRIMARY KEY, rules TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS panel_publications (panel TEXT NOT NULL, channel TEXT NOT NULL, message TEXT PRIMARY KEY);
    CREATE INDEX IF NOT EXISTS publications_panel ON panel_publications(panel);
    CREATE TABLE IF NOT EXISTS ticket_log_routes (channel TEXT PRIMARY KEY, logs TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ticket_panel_sources (channel TEXT PRIMARY KEY, panel TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS ticket_panel_sources_panel ON ticket_panel_sources(panel);
    CREATE TABLE IF NOT EXISTS ticket_panel_routes (channel TEXT PRIMARY KEY, role TEXT NOT NULL);
  `);
}

const idPattern=/^[0-9]{17,20}$/;
const timePattern=/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;
const statuses=['open','reduced','urgent'];
const weekdays=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const limited=(value,max)=>{
  if(typeof value!=='string'||value.length>max)throw Error('Invalid message text');
  return value.trim();
};
const emojiName=(value='')=>{
  const emoji=limited(value,32);
  if(emoji&&!/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(emoji))throw Error('Use a Unicode emoji');
  return emoji;
};
const style=value=>[1,2,3,4].includes(value)?value:2;
const httpsUrl=value=>{
  const raw=limited(value,900);
  if(!raw)return '';
  const url=new URL(raw);
  if(url.protocol!=='https:'||url.username||url.password)throw Error('Invalid media URL');
  return raw;
};
function buttonConfig(input){
  const button=input??{};
  return {enabled:button.enabled!==false,label:limited(button.label??'',80),emoji:emojiName(button.emoji),style:style(button.style)};
}
export function validatePresentation(value,available,owner){
  const p=value??{};
  if(typeof p!=='object'||Array.isArray(p))throw Error('Invalid presentation');
  const links=p.links??[];
  if(!Array.isArray(links)||links.length>20||new Set(links).size!==links.length||links.some(id=>id===owner||!available.includes(id)))throw Error('Invalid linked panels');
  const color=p.color??'#a079ec';
  if(!/^#[a-f0-9]{6}$/i.test(color))throw Error('Invalid color');
  const fields=p.fields??[];
  if(!Array.isArray(fields)||fields.length>4)throw Error('Invalid embed fields');
  const blocks=p.blocks??[];
  if(!Array.isArray(blocks)||blocks.length>8)throw Error('Invalid component blocks');
  const extras=p.extras??[];
  if(!Array.isArray(extras)||extras.length>3)throw Error('Invalid extra embeds');
  const extraEmbeds=extras.map(item=>{
    const title=limited(item?.title??'',256),body=limited(item?.body??'',1000);
    if(!title&&!body)throw Error('Empty embed');
    return {title,body};
  });
  const insideColor=p.inside?.color??'';
  if(insideColor&&!/^#[a-f0-9]{6}$/i.test(insideColor))throw Error('Invalid ticket color');
  return {
    layout:p.layout==='v2'?'v2':'embed',navigation:p.navigation==='menu'?'menu':'buttons',
    links,faqId:limited(p.faqId??'',48),color,title:limited(p.title??'',256),footer:limited(p.footer??'',256),
    author:limited(p.author??'',256),authorUrl:httpsUrl(p.authorUrl??''),authorIcon:httpsUrl(p.authorIcon??''),
    thumbnail:httpsUrl(p.thumbnail??''),footerIcon:httpsUrl(p.footerIcon??''),extras:extraEmbeds,
    image:httpsUrl(p.image??''),description:limited(p.description??'',100),
    opener:buttonConfig(p.opener),placeholder:limited(p.placeholder??'',150),
    fields:fields.map(f=>{
      const name=limited(f.name,256),value=limited(f.value,360);
      if(!name||!value)throw Error('Empty embed field');
      return {name,value,inline:f.inline===true};
    }),
    blocks:blocks.map(b=>{
      if(b.kind==='divider')return {kind:b.kind};
      if(b.kind==='image'){
        const value=httpsUrl(b.value);
        if(!value)throw Error('Empty image URL');
        return {kind:b.kind,value};
      }
      if(b.kind!=='text')throw Error('Invalid component block');
      const value=limited(b.value,1500);
      if(!value)throw Error('Empty block');
      return {kind:'text',value};
    }),
    actionsFirst:p.actionsFirst===true,
    inside:{layout:p.inside?.layout==='v2'?'v2':'embed',message:limited(p.inside?.message??'',900),
      title:limited(p.inside?.title??'',160),footer:limited(p.inside?.footer??'',256),image:httpsUrl(p.inside?.image??''),
      color:insideColor,actionsFirst:p.inside?.actionsFirst===true,claim:buttonConfig(p.inside?.claim),rename:buttonConfig(p.inside?.rename),close:buttonConfig(p.inside?.close),requestClose:buttonConfig({enabled:false,...p.inside?.requestClose})}
  };
}

export function panelMessage(panel,linked,locale){
  const p=panel.rules.presentation??{};
  const fallback=locale==='en'?'Open ticket':'Abrir ticket';
  const items=[panel,...linked];
  const rows=[];
  if(p.navigation==='menu'){
    rows.push({type:1,components:[{type:3,custom_id:'v:choose:'+panel.id,min_values:1,max_values:1,
      placeholder:p.placeholder||(locale==='en'?'Choose a ticket type':'Escolha um tipo de ticket'),
      options:items.map(item=>{
        const look=item.rules.presentation??{},emoji=look.opener?.emoji;
        return {label:look.opener?.label||item.title,value:item.id,...(look.description?{description:look.description}:{}),...(emoji?{emoji:{name:emoji}}:{})};
      })}]});
  }else for(let i=0;i<items.length;i+=5){
    rows.push({type:1,components:items.slice(i,i+5).map(item=>{
      const button=item.rules.presentation?.opener??{};
      return {type:2,style:button.style??1,custom_id:'v:open:'+item.id,
        label:button.label||(items.length>1?item.title:fallback),...(button.emoji?{emoji:{name:button.emoji}}:{})};
    })});
  }
  if(p.faqId){
    const faq={type:2,style:2,custom_id:'v:panel-faq:'+panel.id,label:locale==='en'?'Frequently asked question':'Pergunta frequente'};
    const last=rows.at(-1);
    if(p.navigation!=='menu'&&last?.components.length<5)last.components.push(faq);
    else rows.push({type:1,components:[faq]});
  }
  const color=parseInt((p.color??'#a079ec').slice(1),16);
  if(p.layout==='v2'){
    const blocks=[{type:10,content:'## '+(p.title||panel.title)+'\n'+panel.body},
      ...(p.blocks??[]).map(b=>b.kind==='divider'?{type:14,divider:true,spacing:1}:
        b.kind==='image'?{type:12,items:[{media:{url:b.value}}]}:{type:10,content:b.value})];
    return {flags:32768,components:[{type:17,accent_color:color,components:p.actionsFirst?[...rows,...blocks]:[...blocks,...rows]}],allowed_mentions:{parse:[]}};
  }
  return {embeds:[{title:p.title||panel.title,description:panel.body,color,
    ...(p.author?{author:{name:p.author,...(p.authorUrl?{url:p.authorUrl}:{}),...(p.authorIcon?{icon_url:p.authorIcon}:{})}}:{}),
    ...(p.thumbnail?{thumbnail:{url:p.thumbnail}}:{}),
    ...(p.footer?{footer:{text:p.footer,...(p.footerIcon?{icon_url:p.footerIcon}:{})}}:{}),...(p.fields?.length?{fields:p.fields}:{}),...(p.image?{image:{url:p.image}}:{})},...(p.extras??[]).map(item=>({color,...(item.title?{title:item.title}:{}),...(item.body?{description:item.body}:{})}))],
    components:rows,allowed_mentions:{parse:[]}};
}

export const selectorKinds=new Set(['choice','user','role','channel']);
export function validateRules(value,roles,channels){
  const r=value??{};
  if(typeof r!=='object'||Array.isArray(r))throw Error('Invalid rules');
  const enabled=r.enabled!==false;
  const naming=['area','member'].includes(r.naming)?r.naming:'area';
  const pinOpening=r.pinOpening===true;
  const logChannel=r.logChannel??'';
  if(logChannel&&!channels.some(channel=>channel.id===logChannel&&channel.type===0))throw Error('Invalid log channel');
  const access=r.access??{};
  const roleIds=ids=>{
    if(!Array.isArray(ids)||ids.length>20||new Set(ids).size!==ids.length||ids.some(id=>!roles.some(role=>role.id===id)))throw Error('Invalid access roles');
    return ids;
  };
  const minimumDays=value=>{
    if(!Number.isInteger(value)||value<0||value>365)throw Error('Invalid minimum age');
    return value;
  };
  const policy={required:roleIds(access.required??[]),blocked:roleIds(access.blocked??[]),all:access.all===true,
    accountDays:minimumDays(access.accountDays??0),memberDays:minimumDays(access.memberDays??0)};
  const behavior={enabled,naming,pinOpening,logChannel,access:policy,formEnabled:r.formEnabled!==false};
  const supportRoles=r.supportRoles??(r.role?[r.role]:[]);
  const category=r.category??'', overflow=r.overflow??'';
  if(!Array.isArray(supportRoles)||supportRoles.length>20||new Set(supportRoles).size!==supportRoles.length||
      supportRoles.some(id=>!idPattern.test(id)||!roles.some(role=>role.id===id)))throw Error('Invalid role');
  if(overflow&&(overflow===category||!channels.some(channel=>channel.id===overflow&&channel.type===4)))throw Error('Invalid overflow category');
  if(category&&(!idPattern.test(category)||!channels.some(x=>x.id===category&&x.type===4)))throw Error('Invalid category');
  const q=r.questions??[];
  if(!Array.isArray(q)||q.length>5)throw Error('Invalid questions');
  const questions=q.map(x=>{
    if(x?.kind==='notice')return {kind:'notice',text:limited(x.text??'',1000),label:'',required:false,options:[]};
    if(!x||typeof x.label!=='string'||x.label.trim().length<1||x.label.trim().length>45||!(['short','long','checkbox','file'].includes(x.kind)||selectorKinds.has(x.kind))||typeof x.required!=='boolean')throw Error('Invalid question');
    const options=x.kind==='choice'?x.options:[];
    if(!Array.isArray(options)||x.kind==='choice'&&(options.length<2||options.length>25||options.some(o=>typeof o!=='string'||!o.trim()||o.trim().length>80)))throw Error('Invalid choices');
    const list=options.map(o=>o.trim());
    if(new Set(list).size!==list.length)throw Error('Duplicate choices');
    const selector=selectorKinds.has(x.kind);
    const min=selector?(x.min??Number(x.required)):0,max=selector?(x.max??1):1;
    if(!Number.isInteger(min)||!Number.isInteger(max)||min<Number(selector&&x.required)||max<1||max>25||min>max||
      x.kind==='choice'&&max>list.length)throw Error('Invalid selection limits');
    return {label:x.label.trim(),description:limited(x.description??'',100),kind:x.kind,required:x.required,options:list,min,max};

  });
  if(questions.some(q=>q.kind==='notice')&&(questions.some(q=>q.kind==='notice'&&!q.text)||questions.every(q=>q.kind==='notice')))throw Error('Add a response field and fill the notice');
  const schedule=r.schedule??null;
  if(!schedule)return {...behavior,supportRoles,category,overflow,questions,schedule:null};
  if(typeof schedule.zone!=='string'||schedule.zone.length>80||!['warn','block'].includes(schedule.outside)||!Array.isArray(schedule.days)||schedule.days.length!==7)throw Error('Invalid schedule');
  new Intl.DateTimeFormat('en',{timeZone:schedule.zone});
  const days=schedule.days.map(day=>{
    if(day===null)return null;
    if(!day||!statuses.includes(day.status)||!timePattern.test(day.start)||!timePattern.test(day.end)||day.start>=day.end)throw Error('Invalid hours');
    return {status:day.status,start:day.start,end:day.end};
  });
  const bypass=schedule.bypass??'';
  if(bypass&&(!idPattern.test(bypass)||!roles.some(x=>x.id===bypass)))throw Error('Invalid bypass role');
  return {...behavior,supportRoles,category,overflow,questions,schedule:{zone:schedule.zone,outside:schedule.outside,days,bypass}};
}

export function panelFromDb(db,guild,id) {
  const panel=db.prepare('SELECT p.id,p.title,p.body,r.rules FROM web_panels p LEFT JOIN panel_rules r ON p.id=r.id WHERE p.guild=? AND p.id=?').get(guild,id);
  if(panel)panel.rules=panel.rules?JSON.parse(panel.rules):{};
  return panel;
}
export function revision(panel){
  return createHash('sha256').update(JSON.stringify([panel.rules.formEnabled!==false,panel.rules.questions??[]])).digest('hex').slice(0,10);
}
export function availability(schedule,hasBypass=false,now=new Date()){
  if(!schedule||hasBypass)return 'open';
  const pairs=new Intl.DateTimeFormat('en-GB',{timeZone:schedule.zone,weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
  const parts=Object.fromEntries(pairs.map(p=>[p.type,p.value]));
  const day=schedule.days[weekdays.indexOf(parts.weekday)];
  const time=parts.hour+':'+parts.minute;
  return day&&day.start<=time&&time<day.end?day.status:'closed';
}
