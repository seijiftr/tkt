import { createHash } from 'node:crypto';

export function initPanels(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS web_panels (id TEXT PRIMARY KEY, guild TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS panel_rules (id TEXT PRIMARY KEY, rules TEXT NOT NULL);
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
  return {
    layout:p.layout==='v2'?'v2':'embed',navigation:p.navigation==='menu'?'menu':'buttons',
    links,color,title:limited(p.title??'',256),footer:limited(p.footer??'',256),
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
    inside:{layout:p.inside?.layout==='v2'?'v2':'embed',message:limited(p.inside?.message??'',900),claim:buttonConfig(p.inside?.claim),close:buttonConfig(p.inside?.close)}
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
  const color=parseInt((p.color??'#a079ec').slice(1),16);
  if(p.layout==='v2'){
    const blocks=[{type:10,content:'## '+(p.title||panel.title)+'\n'+panel.body},
      ...(p.blocks??[]).map(b=>b.kind==='divider'?{type:14,divider:true,spacing:1}:
        b.kind==='image'?{type:12,items:[{media:{url:b.value}}]}:{type:10,content:b.value})];
    return {flags:32768,components:[{type:17,accent_color:color,components:p.actionsFirst?[...rows,...blocks]:[...blocks,...rows]}],allowed_mentions:{parse:[]}};
  }
  return {embeds:[{title:p.title||panel.title,description:panel.body,color,
    ...(p.footer?{footer:{text:p.footer}}:{}),...(p.fields?.length?{fields:p.fields}:{}),...(p.image?{image:{url:p.image}}:{})}],
    components:rows,allowed_mentions:{parse:[]}};
}

export function validateRules(value,roles,channels){
  const r=value??{};
  if(typeof r!=='object'||Array.isArray(r))throw Error('Invalid rules');
  const role=r.role??'', category=r.category??'';
  if(role&&(!idPattern.test(role)||!roles.some(x=>x.id===role)))throw Error('Invalid role');
  if(category&&(!idPattern.test(category)||!channels.some(x=>x.id===category&&x.type===4)))throw Error('Invalid category');
  const q=r.questions??[];
  if(!Array.isArray(q)||q.length>5)throw Error('Invalid questions');
  const questions=q.map(x=>{
    if(!x||typeof x.label!=='string'||x.label.trim().length<1||x.label.trim().length>45||!['short','long','choice','checkbox','file'].includes(x.kind)||typeof x.required!=='boolean')throw Error('Invalid question');
    const options=x.kind==='choice'?x.options:[];
    if(!Array.isArray(options)||x.kind==='choice'&&(options.length<2||options.length>10||options.some(o=>typeof o!=='string'||!o.trim()||o.trim().length>80)))throw Error('Invalid choices');
    const list=options.map(o=>o.trim());
    if(new Set(list).size!==list.length)throw Error('Duplicate choices');
    return {label:x.label.trim(),kind:x.kind,required:x.required,options:list};
  });
  const schedule=r.schedule??null;
  if(!schedule)return {role,category,questions,schedule:null};
  if(typeof schedule.zone!=='string'||schedule.zone.length>80||!['warn','block'].includes(schedule.outside)||!Array.isArray(schedule.days)||schedule.days.length!==7)throw Error('Invalid schedule');
  new Intl.DateTimeFormat('en',{timeZone:schedule.zone});
  const days=schedule.days.map(day=>{
    if(day===null)return null;
    if(!day||!statuses.includes(day.status)||!timePattern.test(day.start)||!timePattern.test(day.end)||day.start>=day.end)throw Error('Invalid hours');
    return {status:day.status,start:day.start,end:day.end};
  });
  const bypass=schedule.bypass??'';
  if(bypass&&(!idPattern.test(bypass)||!roles.some(x=>x.id===bypass)))throw Error('Invalid bypass role');
  return {role,category,questions,schedule:{zone:schedule.zone,outside:schedule.outside,days,bypass}};
}

export function panelFromDb(db,guild,id) {
  const panel=db.prepare('SELECT p.id,p.title,p.body,r.rules FROM web_panels p LEFT JOIN panel_rules r ON p.id=r.id WHERE p.guild=? AND p.id=?').get(guild,id);
  if(panel)panel.rules=panel.rules?JSON.parse(panel.rules):{};
  return panel;
}
export function revision(panel){
  return createHash('sha256').update(JSON.stringify(panel.rules.questions??[])).digest('hex').slice(0,10);
}
export function availability(schedule,hasBypass=false,now=new Date()){
  if(!schedule||hasBypass)return 'open';
  const pairs=new Intl.DateTimeFormat('en-GB',{timeZone:schedule.zone,weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
  const parts=Object.fromEntries(pairs.map(p=>[p.type,p.value]));
  const day=schedule.days[weekdays.indexOf(parts.weekday)];
  const time=parts.hour+':'+parts.minute;
  return day&&day.start<=time&&time<day.end?day.status:'closed';
}
