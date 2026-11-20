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
export function validateRules(value,roles,channels){
  const r=value??{};
  if(typeof r!=='object'||Array.isArray(r))throw Error('Invalid rules');
  const role=r.role??'', category=r.category??'';
  if(role&&(!idPattern.test(role)||!roles.some(x=>x.id===role)))throw Error('Invalid role');
  if(category&&(!idPattern.test(category)||!channels.some(x=>x.id===category&&x.type===4)))throw Error('Invalid category');
  const q=r.questions??[];
  if(!Array.isArray(q)||q.length>5)throw Error('Invalid questions');
  const questions=q.map(x=>{
    if(!x||typeof x.label!=='string'||x.label.trim().length<1||x.label.trim().length>45||!['short','long','choice'].includes(x.kind)||typeof x.required!=='boolean')throw Error('Invalid question');
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
