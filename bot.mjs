import {
  Client, Events, GatewayIntentBits, PermissionFlagsBits as Permission,
  ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, SlashCommandBuilder, LabelBuilder, StringSelectMenuBuilder, FileUploadBuilder, CheckboxBuilder,
  AttachmentBuilder, MessageFlags,
} from 'discord.js';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {findFaq,initFaq} from './faq.mjs';
import {availability,initPanels,panelFromDb,revision} from './panels.mjs';

const { DISCORD_TOKEN, DISCORD_GUILD_ID, DATABASE_PATH = 'tkt.sqlite' } = process.env;
if (!DISCORD_TOKEN) throw new Error('Defina DISCORD_TOKEN no arquivo .env.');
const db = new DatabaseSync(DATABASE_PATH);
db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS settings (guild TEXT PRIMARY KEY, role TEXT NOT NULL, category TEXT NOT NULL, logs TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS tickets (
    channel TEXT PRIMARY KEY, guild TEXT NOT NULL, owner TEXT NOT NULL, area TEXT NOT NULL,
    opened INTEGER NOT NULL, closed INTEGER, agent TEXT, priority TEXT NOT NULL DEFAULT 'normal',
    rating INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS one_open_ticket ON tickets(guild, owner) WHERE closed IS NULL;
  CREATE TABLE IF NOT EXISTS guild_locale (guild TEXT PRIMARY KEY, locale TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS ticket_close_requests (
    channel TEXT PRIMARY KEY, id TEXT NOT NULL, requester TEXT NOT NULL, reason TEXT NOT NULL, message TEXT
  );
  CREATE TABLE IF NOT EXISTS ticket_channel_deletions (channel TEXT PRIMARY KEY, due INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS ticket_notes (
    id INTEGER PRIMARY KEY, channel TEXT NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ticket_notes_channel ON ticket_notes(channel,id);
  CREATE TABLE IF NOT EXISTS ticket_events (guild TEXT NOT NULL, channel TEXT NOT NULL, kind TEXT NOT NULL, time INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS event_report ON ticket_events(guild,kind,time);
  CREATE UNIQUE INDEX IF NOT EXISTS first_reply ON ticket_events(channel) WHERE kind='reply';
  CREATE TRIGGER IF NOT EXISTS ticket_claim_event AFTER UPDATE OF agent ON tickets WHEN new.agent IS NOT NULL AND old.agent IS NOT new.agent
  BEGIN INSERT INTO ticket_events VALUES(new.guild,new.channel,'claim',CAST(unixepoch('subsec')*1000 AS INTEGER)); END;
  CREATE TRIGGER IF NOT EXISTS ticket_close_event AFTER UPDATE OF closed ON tickets WHEN old.closed IS NULL AND new.closed IS NOT NULL
  BEGIN INSERT INTO ticket_events VALUES(new.guild,new.channel,'close',new.closed); END;
  CREATE TRIGGER IF NOT EXISTS ticket_reopen_event AFTER UPDATE OF closed ON tickets WHEN old.closed IS NOT NULL AND new.closed IS NULL
  BEGIN INSERT INTO ticket_events VALUES(new.guild,new.channel,'reopen',CAST(unixepoch('subsec')*1000 AS INTEGER)); END;
`);
initFaq(db);
initPanels(db);
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const settings = guild => db.prepare('SELECT * FROM settings WHERE guild=?').get(guild);
const getTicket = channel => db.prepare('SELECT * FROM tickets WHERE channel=?').get(channel);
const language = (guild, fallback) => {
  const locale = guild && db.prepare('SELECT locale FROM guild_locale WHERE guild=?').get(guild)?.locale;
  return locale ? locale === 'en' : ['en-US','en-GB'].includes(fallback);
};
const translated = (i, pt, en, guild=i.guildId) => language(guild, i.locale) ? en : pt;
const guildOnly = 0;
const admin = new SlashCommandBuilder().setName('tkt').setDescription('Configure a central de atendimento')
  .setContexts(guildOnly).setDefaultMemberPermissions(Permission.ManageGuild)
  .addSubcommand(cmd => cmd.setName('configurar').setDescription('Defina equipe, categoria e registros')
    .addRoleOption(o => o.setName('equipe').setDescription('Cargo com acesso aos tickets').setRequired(true))
    .addChannelOption(o => o.setName('categoria').setDescription('Categoria dos tickets').addChannelTypes(ChannelType.GuildCategory).setRequired(true))
    .addChannelOption(o => o.setName('registros').setDescription('Canal privado da equipe').addChannelTypes(ChannelType.GuildText).setRequired(true)))
  .addSubcommand(cmd => cmd.setName('painel').setDescription('Publique um painel de abertura neste canal')
    .addStringOption(o => o.setName('area').setDescription('Ex.: Financeiro').setRequired(true).setMaxLength(80))
    .addStringOption(o => o.setName('mensagem').setDescription('Instruções para o membro').setMaxLength(1000)))
  .addSubcommand(cmd => cmd.setName('fila').setDescription('Veja os totais de atendimento'));
const tickets = new SlashCommandBuilder().setName('ticket').setDescription('Gerencie este atendimento').setContexts(guildOnly);
for (const [name, description] of [
  ['assumir','Assuma o ticket e atualize o nome do canal'], ['encerrar','Arquive o atendimento e gere o registro'],
  ['reabrir','Restaure o acesso do solicitante'], ['historico','Exporte a conversa em texto'],
  ['adicionar','Conceda acesso a um participante'], ['remover','Revogue o acesso de um participante'],
  ['prioridade','Atualize a prioridade'], ['info','Veja os detalhes do ticket'],
  ['solicitar-fechamento','Peça ao solicitante para confirmar o encerramento'],
  ['transferir','Atribua o ticket a outro atendente'], ['anotar','Adicione uma nota privada da equipe'], ['notas','Veja as notas privadas da equipe'],
  ['renomear','Altere o nome do canal do ticket'], ['mover','Mova o ticket para outra categoria'],
]) {
  tickets.addSubcommand(cmd => {
    cmd.setName(name).setDescription(description);
    if (['adicionar','remover','transferir'].includes(name)) cmd.addUserOption(o => o.setName('membro').setDescription('Participante').setRequired(true));
    if (name === 'solicitar-fechamento' || name === 'encerrar') cmd.addStringOption(o=>o.setName('motivo').setDescription('Motivo do encerramento').setMaxLength(200));
    if (name === 'renomear') cmd.addStringOption(o=>o.setName('nome').setDescription('Novo nome do canal').setRequired(true).setMaxLength(100));
    if (name === 'mover') cmd.addChannelOption(o=>o.setName('categoria').setDescription('Categoria de destino').addChannelTypes(ChannelType.GuildCategory).setRequired(true));
    if (name === 'anotar') cmd.addStringOption(o=>o.setName('nota').setDescription('Texto da nota privada').setRequired(true).setMaxLength(600));
    if (name === 'prioridade') cmd.addStringOption(o => o.setName('nivel').setDescription('Prioridade').setRequired(true)
      .addChoices(...['baixa','normal','alta','urgente'].map(value => ({name:value,value}))));
    return cmd;
  });
}
// Ratings are collected through a button sent to the requester in DM.
const commandData = tickets.toJSON();
const words = {
  'solicitar-fechamento':['request-close','Ask the requester to confirm closure'],
  motivo:['reason','Reason for closure'],info:['info','Show ticket details'],
  renomear:['rename','Rename the ticket channel'],nome:['name','New channel name'],
  transferir:['transfer','Assign the ticket to another staff member'],anotar:['add-note','Add a private staff note'],notas:['notes','Show private staff notes'],nota:['note','Private note text'],
  mover:['move','Move the ticket to another category'],
  "configurar": [
    "configure",
    "Set the support role, ticket category and log channel"
  ],
  "equipe": [
    "team",
    "Role with access to tickets"
  ],
  "categoria": [
    "category",
    "Ticket category"
  ],
  "registros": [
    "logs",
    "Private staff channel"
  ],
  "painel": [
    "panel",
    "Publish a ticket panel in this channel"
  ],
  "area": [
    "area",
    "For example: Billing"
  ],
  "mensagem": [
    "message",
    "Instructions for members"
  ],
  "fila": [
    "queue",
    "Show current ticket totals"
  ],
  "assumir": [
    "claim",
    "Claim the ticket and rename its channel"
  ],
  "encerrar": [
    "close",
    "Archive the ticket and generate a transcript"
  ],
  "reabrir": [
    "reopen",
    "Restore access for the requester"
  ],
  "historico": [
    "transcript",
    "Export the conversation as text"
  ],
  "adicionar": [
    "add",
    "Grant access to a participant"
  ],
  "remover": [
    "remove",
    "Revoke participant access"
  ],
  "membro": [
    "member",
    "Participant"
  ],
  "prioridade": [
    "priority",
    "Update ticket priority"
  ],
  "nivel": [
    "level",
    "Priority level"
  ]
};
function localize(command,desc){
  const [name,description]=words[command.name]??[command.name,desc];
  if(description){
    command.name_localizations={'en-US':name,'en-GB':name};
    command.description_localizations={'en-US':description,'en-GB':description};
  }
  for(const child of command.options??[])localize(child);
  for(const choice of command.choices??[]){
    const name={baixa:'low',normal:'normal',alta:'high',urgente:'urgent'}[choice.value];
    if(name)choice.name_localizations={'en-US':name,'en-GB':name};
  }
  return command;
}
const pending = new Set();
async function exclusive(key, work) {
  if (pending.has(key)) throw new Error('Já existe uma operação em andamento. Tente novamente em instantes.');
  pending.add(key);
  try { return await work(); } finally { pending.delete(key); }
}
const privateReply = (i, content) => i.reply({ content, flags: MessageFlags.Ephemeral });
const panelRole = channel => db.prepare('SELECT role FROM ticket_panel_routes WHERE channel=?').get(channel)?.role;
const canManage = (i, config) => i.memberPermissions?.has(Permission.ManageGuild) || [config.role,panelRole(i.channelId)].some(role=>role&&i.member?.roles?.cache?.has(role));
function checkAvailability(i,panel){
  const schedule=panel.rules.schedule;
  const bypass=schedule?.bypass&&i.member?.roles?.cache?.has(schedule.bypass);
  const state=availability(schedule,bypass);
  const warning={
    closed:translated(i,'Estamos fora do horário de atendimento. A resposta pode demorar.','Support is outside business hours. A reply may take longer.'),
    reduced:translated(i,'Estamos com atendimento reduzido.','Support is operating at reduced capacity.'),
    urgent:translated(i,'Neste horário, a equipe prioriza casos urgentes.','Support is prioritizing urgent cases at this time.')
  }[state]??'';
  if(state==='closed'&&schedule.outside==='block')throw new Error(translated(i,'Este painel abre tickets apenas durante o horário de atendimento.','This panel accepts tickets only during business hours.'));
  return warning;
}
function panelModal(i,panel){
  const form=panel.rules.questions??[];
  const title=(translated(i,'Abrir','Open')+' · '+panel.title).slice(0,45);
  const modal=new ModalBuilder().setCustomId('v:form:'+panel.id+':'+revision(panel)).setTitle(title);
  if(!form.length){
    const text=new TextInputBuilder().setCustomId('description').setStyle(TextInputStyle.Paragraph).setMaxLength(1800).setRequired(true);
    return modal.addLabelComponents(new LabelBuilder().setLabel(translated(i,'Descreva seu pedido','Describe your request')).setTextInputComponent(text));
  }
  for(const [index,question] of form.entries()){
    const label=new LabelBuilder().setLabel(question.label);
    const id='q'+index;
    if(question.kind==='choice'){
      const menu=new StringSelectMenuBuilder().setCustomId(id).setRequired(question.required).setMinValues(question.required?1:0).setMaxValues(1)
        .addOptions(question.options.map((option,n)=>({label:option,value:String(n)})));
      label.setStringSelectMenuComponent(menu);
    }else if(question.kind==='file'){
      label.setFileUploadComponent(new FileUploadBuilder().setCustomId(id).setRequired(question.required)
        .setMinValues(question.required?1:0).setMaxValues(1));
    }else if(question.kind==='checkbox'){
      label.setCheckboxComponent(new CheckboxBuilder().setCustomId(id));
    }else{
      const input=new TextInputBuilder().setCustomId(id).setStyle(question.kind==='short'?TextInputStyle.Short:TextInputStyle.Paragraph)
        .setMaxLength(question.kind==='short'?220:950).setRequired(question.required);
      label.setTextInputComponent(input);
    }
    modal.addLabelComponents(label);
  }
  return modal;
}
function panelAnswers(i,panel){
  const fields=[],uploads=[];
  for(const [index,question] of (panel.rules.questions??[]).entries()){
    const id='q'+index;
    let value='';
    if(i.fields.fields.has(id)){
      if(question.kind==='choice')value=question.options[Number(i.fields.getStringSelectValues(id)[0])]??'';
      else if(question.kind==='checkbox'){
        const checked=i.fields.getCheckbox(id);
        if(checked||!question.required)value=checked?translated(i,'Sim','Yes'):translated(i,'Não','No');
      }else if(question.kind==='file'){
        const file=i.fields.getUploadedFiles(id)?.first();
        if(file){uploads.push(file);value=file.name||translated(i,'Arquivo','File')}
      }else value=i.fields.getTextInputValue(id).trim();
    }
    if(question.required&&!value)throw new Error(translated(i,'Preencha as perguntas obrigatórias.','Answer the required questions.'));
    if(value)fields.push({name:question.label,value});
  }
  if(uploads.reduce((sum,file)=>sum+file.size,0)>8*1024*1024)throw new Error(translated(i,'Os anexos devem somar até 8 MB.','Attachments must total at most 8 MB.'));
  return {fields,uploads};
}
async function downloadUploads(uploads){
  return Promise.all(uploads.map(async (file,index)=>{
    const url=new URL(file.url);
    if(url.protocol!=='https:'||!['cdn.discordapp.com','media.discordapp.net'].includes(url.hostname))throw Error('Invalid Discord attachment URL.');
    const response=await fetch(url,{signal:AbortSignal.timeout(12000),redirect:'error'});
    if(!response.ok||!response.body)throw Error('Discord attachment unavailable.');
    const chunks=[];
    let bytes=0;
    for await (const chunk of response.body){
      bytes+=chunk.length;
      if(bytes>file.size||bytes>8*1024*1024)throw Error('Invalid Discord attachment size.');
      chunks.push(chunk);
    }
    if(bytes!==file.size)throw Error('Incomplete Discord attachment.');
    return new AttachmentBuilder(Buffer.concat(chunks),{name:(index+1)+'-'+file.name.replace(/[^a-z0-9_.-]/gi,'_').slice(0,85)});
  }));
}
function channelSlug(value){
  return value.normalize('NFKD').replace(/\p{Mark}/gu,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
}
function ticketActions(i,panel){
  const look=panel?.rules.presentation?.inside;
  const defaults=[
    ['v:assumir',translated(i,'Assumir','Claim'),ButtonStyle.Primary,look?.claim],
    ['v:renomear',translated(i,'Renomear','Rename'),ButtonStyle.Secondary,look?.rename],
    ['v:encerrar',translated(i,'Fechar','Close'),ButtonStyle.Danger,look?.close]
  ];
  const components=defaults.map(([id,label,style,item])=>{
    const button=new ButtonBuilder().setCustomId(id).setLabel(item?.label||label).setStyle(item?.style??style);
    if(item?.emoji)button.setEmoji(item.emoji);
    return button;
  });
  return components.length?[new ActionRowBuilder().addComponents(components)]:[];
}
const buttons = (...items) => new ActionRowBuilder().addComponents(items.map(([id,label,style]) =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style)));
const card = (title, description) => new EmbedBuilder().setColor(0x9a62e7).setTitle(title).setDescription(description);
const allowed = { parse: [] };

function componentTexts(components){
  return components.flatMap(item=>item.content?[item.content]:componentTexts(item.components??[]));
}
function firstTicketMessage(i,area,description,answers,warning,panel,files){
  const presentation=panel?.rules.presentation;
  const inside=presentation?.inside;
  const title=inside?.title||area;
  const color=parseInt((inside?.color||(inside?.layout==='v2'?presentation.color:'#9a62e7')).slice(1),16);
  const content=[warning,inside?.message].filter(Boolean);
  const fields=[{name:translated(i,'Solicitante','Requester'),value:'<@'+i.user.id+'>'},...answers];
  const actions=ticketActions(i,panel);
  if(inside?.layout==='v2'){
    const parts=[{type:10,content:'## '+title},...content.map(value=>({type:10,content:value})),
      {type:10,content:description},...fields.map(f=>({type:10,content:'**'+f.name+'**\n'+f.value})),
      ...files.map(file=>({type:13,file:{url:'attachment://'+file.name}}))];
    if(inside.image)parts.push({type:12,items:[{media:{url:inside.image}}]});
    if(inside.footer)parts.push({type:10,content:'-# '+inside.footer});
    const buttons=actions.map(row=>row.toJSON());
    return {flags:MessageFlags.IsComponentsV2,components:[{type:17,accent_color:color,components:inside.actionsFirst?[...buttons,...parts]:[...parts,...buttons]}],allowedMentions:allowed,files};
  }
  const embed=card(title,description).setColor(color).addFields(...fields);
  if(inside?.image)embed.setImage(inside.image);
  if(inside?.footer)embed.setFooter({text:inside.footer});
  return { ...(content.length?{content:content.join('\n\n')}:{}),
    embeds:[embed],allowedMentions:allowed,components:actions,files};
}
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
function attachmentUrl(raw){
  try{
    const url=new URL(raw);
    return url.protocol==='https:'&&['cdn.discordapp.com','media.discordapp.net'].includes(url.hostname)?escapeHtml(url.href):'';
  }catch{return ''}
}
async function transcript(channel,i,record,reason='') {
  const pages = [];
  let before;
  for (;;) {
    const page = await channel.messages.fetch({limit:100, before, cache:false});
    if (!page.size) break;
    pages.push([...page.values()]);
    if (page.size < 100) break;
    before = page.last().id;
  }
  const lang=translated(i,'pt-BR','en');
  const format=new Intl.DateTimeFormat(lang,{dateStyle:'medium',timeStyle:'short',timeZone:'UTC'});
  const messages=pages.flat().reverse();
  const rows=messages.map(message=>{
    const name=escapeHtml(message.member?.displayName||message.author.globalName||message.author.username);
    const avatar=attachmentUrl(message.author.displayAvatarURL?.({size:64}));
    const files=[...message.attachments.values()].map(file=>{
      const url=attachmentUrl(file.url),label=escapeHtml(file.name);
      return url?'<a href="'+url+'" target="_blank" rel="noopener noreferrer">'+label+'</a>':label;
    });
    const embeds=message.embeds.map(embed=>[embed.title,embed.description,...embed.fields.map(field=>field.name+': '+field.value)].filter(Boolean).join('\n'));
    const contents=[message.content,...embeds,...componentTexts(message.components.map(item=>item.toJSON()))].filter(Boolean);
    const date=message.createdAt;
    return '<article>'+(avatar?'<img alt="" loading="lazy" src="'+avatar+'">':'<span class="avatar" aria-hidden="true">'+name.slice(0,1)+'</span>')+
      '<div><div class="meta"><strong>'+name+'</strong>'+ (message.author.bot?'<small>APP</small>':'')+
      '<time datetime="'+date.toISOString()+'">'+format.format(date)+' UTC</time></div>'+
      contents.map(value=>'<div class="text">'+escapeHtml(value)+'</div>').join('')+
      (files.length?'<ul>'+files.map(file=>'<li>'+file+'</li>').join('')+'</ul>':'')+'</div></article>';
  }).join('');
  const title=escapeHtml(record.area), channelName=escapeHtml(channel.name||channel.id);
  const transcriptTitle=translated(i,'Histórico do ticket','Ticket transcript');
  const metadata=[translated(i,'Solicitante','Requester')+' '+record.owner,translated(i,'Abertura','Opened')+' '+format.format(record.opened)+' UTC',messages.length+' '+translated(i,'mensagens','messages')];
  const html='<!doctype html><html lang="'+lang+'"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+
    '<meta http-equiv="Content-Security-Policy" content="default-src &apos;none&apos;; style-src &apos;unsafe-inline&apos;; img-src https://cdn.discordapp.com https://media.discordapp.net">'+
    '<meta name="referrer" content="no-referrer"><title>'+transcriptTitle+' · '+title+'</title><style>'+
    ':root{color-scheme:dark;font:16px/1.55 system-ui;background:#100c1a;color:#f5eefe}*{box-sizing:border-box}body{margin:0}main{max-width:920px;margin:auto;padding:clamp(16px,5vw,48px)}header{padding:24px;background:#251639;border:1px solid #493264;border-radius:16px;margin-bottom:18px}h1{margin:7px 0;font-size:clamp(25px,5vw,40px);line-height:1.1;overflow-wrap:anywhere}p{margin:8px 0}.label,a{color:#d8b8ff}.label{font-weight:700}article{display:grid;grid-template-columns:36px minmax(0,1fr);gap:12px;padding:15px 8px;border-bottom:1px solid #332443}article img,.avatar{width:36px;height:36px;border-radius:50%;background:#4a2e69}.avatar{display:grid;place-items:center}.meta{display:flex;gap:9px;align-items:baseline;flex-wrap:wrap}time,small,footer,.details{color:#c3b1d1}time,small{font-size:.78rem}.text{white-space:pre-wrap;overflow-wrap:anywhere;margin-top:4px}li{overflow-wrap:anywhere}ul{margin:5px 0}footer{padding-top:18px}</style></head><body><main><header>'+
    '<span class="label">TKT · '+transcriptTitle+'</span><h1>'+title+'</h1><p>#'+channelName+' · '+escapeHtml(channel.id)+'</p>'+
    '<p class="details">'+metadata.map(escapeHtml).join(' · ')+'</p>'+
    (reason?'<p>'+translated(i,'Motivo','Reason')+' · '+escapeHtml(reason)+'</p>':'')+
    '</header>'+rows+'<footer>TKT · Discord</footer></main></body></html>';
  return new AttachmentBuilder(Buffer.from(html),{name:'ticket-' + channel.id + '.html'});
}

function scheduleChannelDeletion(channelId,due,channel,retryDelay=0){
  const timer=setTimeout(async()=>{
    try{
      if(!db.prepare('SELECT 1 FROM ticket_channel_deletions WHERE channel=? AND due=?').get(channelId,due))return;
      const target=channel??await client.channels.fetch(channelId);
      if(target)await target.delete('TKT: ticket fechado com histórico salvo');
    }catch(error){
      if(error.code!==10003){
        console.error('TKT: falha ao excluir canal',channelId,error.code??error.name);
        scheduleChannelDeletion(channelId,due,undefined,60000);
        return;
      }
    }
    db.prepare('DELETE FROM ticket_channel_deletions WHERE channel=? AND due=?').run(channelId,due);
  },Math.max(retryDelay,due-Date.now()));
  timer.unref();
}

async function openTicket(i, config, panel=null) {
  return exclusive('open:' + i.guildId + ':' + i.user.id, async () => {
    const existing = db.prepare('SELECT channel FROM tickets WHERE guild=? AND owner=? AND closed IS NULL').get(i.guildId,i.user.id);
    if (existing) {
      const current = await i.guild.channels.fetch(existing.channel).catch(error => {
        if (error.code === 10003) return null;
        throw error;
      });
      if (current) return i.editReply(translated(i,'Você já tem um ticket aberto em','You already have an open ticket in')+' <#'+existing.channel+'>.');
      db.prepare('UPDATE tickets SET closed=? WHERE channel=?').run(Date.now(),existing.channel);
    }
    const area=panel?.title??i.message?.embeds[0]?.title?.trim();
    const warning=panel?checkAvailability(i,panel):'';
    const hasForm=Boolean(panel?.rules.questions?.length);
    const description=hasForm?translated(i,'Respostas do formulário','Form responses'):i.fields.getTextInputValue('description').trim();
    if(!area||!description)throw new Error(translated(i,'Preencha a área e a descrição.','Enter the area and description.'));
    const {fields:answers,uploads}=hasForm?panelAnswers(i,panel):{fields:[],uploads:[]};
    const files=await downloadUploads(uploads);
    const category=panel?.rules.category||config.category;
    const supportRoles=[...new Set([config.role,panel?.rules.role].filter(Boolean))];
    const name=(channelSlug(area)||'ticket').slice(0,100);
    const channel = await i.guild.channels.create({
      name, type: ChannelType.GuildText, parent:category,
      permissionOverwrites:[
        {id:i.guildId, type:0, deny:[Permission.ViewChannel]},
        ...supportRoles.map(id=>({id,type:0,allow:[Permission.ViewChannel,Permission.SendMessages,Permission.ReadMessageHistory]})),
        {id:i.user.id, type:1, allow:[Permission.ViewChannel,Permission.SendMessages,Permission.ReadMessageHistory]},
        {id:client.user.id, type:1, allow:[Permission.ViewChannel,Permission.SendMessages,Permission.ReadMessageHistory]},
      ],
    });
    try {
      db.prepare('INSERT INTO tickets(channel,guild,owner,area,opened) VALUES(?,?,?,?,?)')
        .run(channel.id,i.guildId,i.user.id,area,Date.now());
      if(panel?.rules.role)db.prepare('INSERT INTO ticket_panel_routes VALUES(?,?)').run(channel.id,panel.rules.role);
      await channel.send(firstTicketMessage(i,area,description,answers,warning,panel,files));
    } catch (error) {
      db.prepare('DELETE FROM ticket_panel_routes WHERE channel=?').run(channel.id);
      db.prepare('DELETE FROM tickets WHERE channel=?').run(channel.id);
      await channel.delete('Falha na abertura do ticket').catch(console.error);
      throw error;
    }
    return i.editReply(translated(i,'Seu atendimento está em','Your ticket is in')+' <#'+channel.id+'>.');
  });
}

const getCloseRequest=channel=>db.prepare('SELECT * FROM ticket_close_requests WHERE channel=?').get(channel);
const removeCloseRequest=(channel,id)=>db.prepare('DELETE FROM ticket_close_requests WHERE channel=? AND id=?').run(channel,id);
async function resolveCloseCard(i,request,content){
  if(!request?.message)return;
  await i.channel.messages.edit(request.message,{content,components:[],allowedMentions:allowed}).catch(()=>{});
}
async function requestClose(i,record){
  if(getCloseRequest(record.channel))return i.editReply(translated(i,'Já há um pedido de encerramento pendente.','There is already a pending close request.'));
  const id=randomUUID(),reason=i.isChatInputCommand()?i.options.getString('motivo')?.trim()||'':'';
  db.prepare('INSERT INTO ticket_close_requests(channel,id,requester,reason) VALUES(?,?,?,?)').run(record.channel,id,i.user.id,reason);
  try{
    const notice=translated(i,'A equipe pediu o encerramento deste ticket','The team requested closure of this ticket');
    const message=await i.channel.send({
      content:'<@'+record.owner+'> '+notice+'.'+(reason?'\n'+translated(i,'Motivo','Reason')+': '+reason:''),
      components:[buttons(
        ['v:close-yes:'+id,translated(i,'Confirmar encerramento','Confirm closure'),ButtonStyle.Danger],
        ['v:close-no:'+id,translated(i,'Manter aberto','Keep open'),ButtonStyle.Secondary]
      )],allowedMentions:{parse:[],users:[record.owner]}
    });
    db.prepare('UPDATE ticket_close_requests SET message=? WHERE channel=? AND id=?').run(message.id,record.channel,id);
  }catch(e){removeCloseRequest(record.channel,id);throw e}
  return i.editReply(translated(i,'Pedido enviado ao solicitante.','Request sent to the ticket requester.'));
}
async function ticketActionModal(i,config,action){
  const ticket=getTicket(i.channelId);
  if(!ticket||ticket.guild!==i.guildId||ticket.closed)return privateReply(i,translated(i,'Este ticket não está aberto.','This ticket is not open.'));
  if(!canManage(i,config)&&!(action==='encerrar'&&ticket.owner===i.user.id))
    return privateReply(i,translated(i,'Ação reservada à equipe de suporte.','Only support staff can do that.'));
  const closing=action==='encerrar';
  const label=closing?translated(i,'Motivo do fechamento','Reason for closing'):translated(i,'Novo nome do canal','New channel name');
  const field=new TextInputBuilder().setCustomId('value').setLabel(label).setRequired(true)
    .setMaxLength(closing?200:100).setStyle(closing?TextInputStyle.Paragraph:TextInputStyle.Short);
  if(!closing)field.setValue(i.channel.name);
  return i.showModal(new ModalBuilder().setCustomId('v:action:'+action)
    .setTitle(closing?translated(i,'Fechar ticket','Close ticket'):translated(i,'Renomear canal','Rename channel'))
    .addComponents(new ActionRowBuilder().addComponents(field)));
}
async function manage(i, config, action, requestId) {
  await i.deferReply({flags:MessageFlags.Ephemeral});
  return exclusive(i.channelId, async () => {
    const record = getTicket(i.channelId);
    if (!record || record.guild !== i.guildId) throw new Error('Este canal não é um ticket do TKT.');
    const staff = canManage(i,config);
    const owner=i.user.id===record.owner;
    if (!staff && !(owner && ['encerrar','info','close-yes','close-no'].includes(action))) throw new Error(translated(i,'Ação reservada à equipe de suporte.',"Only support staff can do that."));
    const channel = i.channel;
    if(action==='info'){
      const lines=[
        translated(i,'Área','Area')+' · '+record.area,
        translated(i,'Solicitante','Requester')+' · <@'+record.owner+'>',
        translated(i,'Status','Status')+' · '+(record.closed?translated(i,'Encerrado','Closed'):translated(i,'Aberto','Open')),
        translated(i,'Abertura','Opened')+' · <t:'+Math.floor(record.opened/1000)+':f>',
        translated(i,'Responsável','Assignee')+' · '+(record.agent?'<@'+record.agent+'>':'—'),
        translated(i,'Prioridade','Priority')+' · '+record.priority
      ];
      return i.editReply({content:lines.join('\n'),allowedMentions:allowed});
    }
    if (action === 'historico') return i.editReply({files:[await transcript(channel,i,record)]});
    if (action === 'reabrir') {
      if(db.prepare('SELECT 1 FROM ticket_channel_deletions WHERE channel=?').get(channel.id))throw new Error(translated(i,'O canal deste ticket está programado para exclusão.','This ticket channel is scheduled for deletion.'));
      if (!record.closed) throw new Error(translated(i,'Este ticket já está aberto.',"This ticket is already open."));
      return exclusive('open:' + i.guildId + ':' + record.owner, async () => {
        const current = db.prepare('SELECT channel FROM tickets WHERE guild=? AND owner=? AND closed IS NULL').get(i.guildId,record.owner);
        if (current) throw new Error(translated(i,'O solicitante já possui outro ticket aberto.',"The requester already has another open ticket."));
        await channel.permissionOverwrites.edit(record.owner,{ViewChannel:true,SendMessages:true,ReadMessageHistory:true},{type:1});
        db.prepare('UPDATE tickets SET closed=NULL, rating=NULL WHERE channel=?').run(channel.id);
        return i.editReply(translated(i,'Ticket reaberto.',"Ticket reopened."));
      });
    }
    if(action==='notas'){
      const rows=db.prepare('SELECT author,body,created FROM ticket_notes WHERE channel=? ORDER BY id DESC LIMIT 3').all(channel.id);
      if(!rows.length)return i.editReply(translated(i,'Sem notas internas.','No private notes.'));
      return i.editReply({content:rows.map(row=>'<@'+row.author+'> · <t:'+Math.floor(row.created/1000)+':f>\n'+row.body).join('\n\n'),allowedMentions:allowed});
    }
    if(action==='anotar'){
      const note=i.options.getString('nota',true).trim();
      if(!note)throw new Error(translated(i,'Escreva uma nota.','Enter a note.'));
      db.prepare('INSERT INTO ticket_notes(channel,author,body,created) VALUES(?,?,?,?)').run(channel.id,i.user.id,note,Date.now());
      return i.editReply(translated(i,'Nota privada salva.','Private note saved.'));
    }
    if (record.closed) throw new Error(translated(i,'Este atendimento já foi encerrado.',"This ticket is already closed."));
    if(action==='solicitar-fechamento')return requestClose(i,record);
    const closeRequest=getCloseRequest(channel.id);
    if(action==='close-yes'||action==='close-no'){
      if(!closeRequest||closeRequest.id!==requestId)throw new Error(translated(i,'Esse pedido já foi resolvido.','This request has already been resolved.'));
      if(action==='close-yes'&&!owner)throw new Error(translated(i,'Só o solicitante pode aceitar o pedido.','Only the ticket requester can accept.'));
      if(action==='close-no'){
        removeCloseRequest(channel.id,closeRequest.id);
        const notice=translated(i,'Pedido cancelado. O ticket continua aberto.','Request cancelled. The ticket remains open.');
        await resolveCloseCard(i,closeRequest,notice);
        return i.editReply(notice);
      }
    }
    if (action === 'encerrar'||action==='close-yes') {
      const reason=action==='close-yes'?closeRequest.reason:i.isModalSubmit()?i.fields.getTextInputValue('value').trim():i.isChatInputCommand()?i.options.getString('motivo')?.trim()||'':'';
      if(i.isModalSubmit()&&!reason)throw new Error(translated(i,'Informe o motivo do fechamento.','Enter a reason for closing.'));
      const log = await i.guild.channels.fetch(config.logs);
      if (log.id === channel.id || !log.isTextBased()) throw new Error('Configure um canal separado para os registros.');
      if (log.permissionsFor(i.guild.roles.everyone)?.has(Permission.ViewChannel)) throw new Error(translated(i,'O canal de registros precisa ser privado.',"The log channel must be private."));
      const file = await transcript(channel,i,record,reason);
      await log.send({content:'Ticket **'+channel.id+'** '+translated(i,'encerrado por','closed by')+' <@'+i.user.id+'>.'+(reason?'\n'+translated(i,'Motivo','Reason')+': '+reason:''), files:[file],allowedMentions:allowed});
      const countdown=translated(i,'O ticket será encerrado e o canal será excluído em 5 segundos.','This ticket will close and the channel will be deleted in 5 seconds.');
      await channel.send({content:countdown,allowedMentions:allowed}).catch(error=>console.error('TKT countdown:',error.code??error.name));
      const closedAt = Date.now();
      const due=closedAt+5000;
      db.exec('BEGIN');
      try{
        db.prepare('UPDATE tickets SET closed=? WHERE channel=?').run(closedAt,channel.id);
        db.prepare('INSERT INTO ticket_channel_deletions VALUES(?,?)').run(channel.id,due);
        db.exec('COMMIT');
      }catch(error){
        db.exec('ROLLBACK');
        throw error;
      }
      scheduleChannelDeletion(channel.id,due,channel);
      if(closeRequest){
        removeCloseRequest(channel.id,closeRequest.id);
        await resolveCloseCard(i,closeRequest,translated(i,'Ticket encerrado.','Ticket closed.'));
      }
      await i.editReply(translated(i,'Histórico salvo. O canal será excluído em 5 segundos.','Transcript saved. The channel will be deleted in 5 seconds.')).catch(console.error);
      const requester = await client.users.fetch(record.owner).catch(()=>null);
      if (requester) await requester.send({
        content:translated(i,'Como foi o atendimento em','How was your support experience in')+' **'+i.guild.name+'**?',
        components:[buttons(...[1,2,3,4,5].map(n=>['v:rate:'+channel.id+':'+closedAt+':'+n,String(n),ButtonStyle.Secondary]))],
        allowedMentions:allowed,
      }).catch(()=>{});
      return;
    }
    if (action === 'assumir') {
      if (record.agent && record.agent !== i.user.id && !i.memberPermissions.has(Permission.ManageGuild)) {
        throw new Error(translated(i,'Outro atendente já assumiu este ticket.',"Another staff member has claimed this ticket."));
      }
      const agent=i.user.id;
      if(record.agent===agent)return i.editReply(translated(i,'Você já assumiu este ticket.','You already claimed this ticket.'));
      const base=channelSlug(record.area)||'ticket';
      const staff=(channelSlug(i.member?.displayName||i.user.globalName||i.user.username||'')||agent).slice(0,45);
      await channel.setName(base.slice(0,99-staff.length).replace(/-+$/,'')+'-'+staff);
      db.prepare('UPDATE tickets SET agent=? WHERE channel=?').run(agent,channel.id);
      await channel.send({content:translated(i,'Atendimento assumido por','Ticket claimed by')+' <@'+agent+'>.',allowedMentions:allowed});
      return i.editReply(translated(i,'Ticket assumido.','Ticket claimed.'));
    }
    if(action==='transferir'){
      const admin=i.memberPermissions?.has(Permission.ManageGuild);
      if(record.agent&&record.agent!==i.user.id&&!admin)
        throw new Error(translated(i,'Apenas o responsável ou um administrador pode transferir este ticket.','Only the assignee or an administrator can transfer this ticket.'));
      const target=await i.guild.members.fetch(i.options.getUser('membro',true).id);
      const staffRoles=[config.role,panelRole(channel.id)].filter(Boolean);
      if(target.user.bot||!channel.permissionsFor(target)?.has(Permission.ViewChannel)||
        !(target.permissions.has(Permission.ManageGuild)||staffRoles.some(role=>target.roles.cache.has(role))))
        throw new Error(translated(i,'Escolha um atendente com acesso ao ticket.','Choose a staff member who can access the ticket.'));
      db.prepare('UPDATE tickets SET agent=? WHERE channel=?').run(target.id,channel.id);
      await channel.send({content:translated(i,'Atendimento transferido para','Ticket transferred to')+' <@'+target.id+'>.',allowedMentions:allowed});
      return i.editReply(translated(i,'Responsável atualizado.','Assignee updated.'));
    }
    if(action==='renomear'){
      const name=channelSlug(i.isModalSubmit()?i.fields.getTextInputValue('value'):i.options.getString('nome',true)).slice(0,100);
      if(!name)throw new Error(translated(i,'Informe um nome válido.','Enter a valid name.'));
      await channel.setName(name);
      return i.editReply(translated(i,'Canal renomeado.','Channel renamed.'));
    }
    if(action==='mover'){
      const category=i.options.getChannel('categoria',true);
      if(category.guild.id!==i.guildId||category.type!==ChannelType.GuildCategory)throw new Error(translated(i,'Escolha uma categoria deste servidor.','Select a category in this server.'));
      await channel.setParent(category.id,{lockPermissions:false});
      return i.editReply(translated(i,'Ticket movido.','Ticket moved.'));
    }
    if (action === 'prioridade') {
      const level = i.options.getString('nivel',true);
      db.prepare('UPDATE tickets SET priority=? WHERE channel=?').run(level,channel.id);
      return i.editReply('Prioridade definida como **'+level+'**.');
    }
    const user = i.options.getUser('membro',true);
    if (user.id === record.owner || user.id === client.user.id) throw new Error('O solicitante e o bot têm acesso gerenciado pelo ticket.');
    if (action === 'adicionar') {
      await i.guild.members.fetch(user.id);
      await channel.permissionOverwrites.edit(user.id,{ViewChannel:true,SendMessages:true,ReadMessageHistory:true},{type:1});
    } else if (action === 'remover') {
      await channel.permissionOverwrites.delete(user.id);
    } else throw new Error('Ação desconhecida.');
    return i.editReply(translated(i,'Acesso do participante atualizado.',"Participant access updated."));
  });
}

client.once(Events.ClientReady, async bot => {
  for(const job of db.prepare('SELECT channel,due FROM ticket_channel_deletions').all())scheduleChannelDeletion(job.channel,job.due);
  try {
    const faqCommand = new SlashCommandBuilder().setName('faq')
      .setDescription('Pesquise perguntas frequentes')
      .setDescriptionLocalizations({'en-US':'Search frequently asked questions','en-GB':'Search frequently asked questions'})
      .setContexts(guildOnly)
      .addStringOption(o=>o.setName('busca').setDescription('Palavra ou assunto')
        .setNameLocalizations({'en-US':'search','en-GB':'search'})
        .setDescriptionLocalizations({'en-US':'Word or topic','en-GB':'Word or topic'}).setMaxLength(80))
      .addStringOption(o=>o.setName('idioma').setDescription('Idioma da resposta')
        .setNameLocalizations({'en-US':'language','en-GB':'language'})
        .setDescriptionLocalizations({'en-US':'Answer language','en-GB':'Answer language'})
        .addChoices({name:'Português (Brasil)',value:'pt-BR'},{name:'English',value:'en'}));
    const commands = [faqCommand.toJSON(),localize(admin.toJSON(),'Configure the support desk'), localize(commandData,'Manage this ticket')];
    if (DISCORD_GUILD_ID) {
      const guild = await bot.guilds.fetch(DISCORD_GUILD_ID);
      await guild.commands.set(commands.map(({contexts, ...command}) => command));
    } else await bot.application.commands.set(commands);
    console.log('TKT conectado como',bot.user.tag);
  } catch (error) { console.error('Falha ao registrar comandos:',error); }
});
client.on(Events.InteractionCreate, async i => {
  try {
    if (i.isButton() && i.customId.startsWith('v:rate:')) {
      const [, ,channel, closedAt, rating] = i.customId.split(':');
      if (!/^[1-5]$/.test(rating)) return;
      const result = db.prepare('UPDATE tickets SET rating=? WHERE channel=? AND owner=? AND closed=? AND rating IS NULL')
        .run(Number(rating),channel,i.user.id,Number(closedAt));
      return await i.reply({content:result.changes ? 'Avaliação registrada. Obrigado!' : 'Esta avaliação já foi registrada ou está indisponível.'});
    }
    if (!i.inGuild()) return;
    if(i.isChatInputCommand()&&i.commandName==='faq'){
      const locale=i.options.getString('idioma')??translated(i,'pt-BR','en');
      const query=i.options.getString('busca')??'';
      const results=findFaq(db,i.guildId,locale,query);
      if(!results.length)return await privateReply(i,translated(i,'Nenhuma resposta encontrada.','No answers found.'));
      return await i.reply({flags:MessageFlags.Ephemeral,allowedMentions:allowed,embeds:results.map(r=>card(r.question,r.answer))});
    }
    const config = settings(i.guildId);
    if (i.isChatInputCommand() && i.commandName === 'tkt') {
      if (!i.memberPermissions.has(Permission.ManageGuild)) return await privateReply(i,'Você precisa da permissão Gerenciar servidor.');
      const action = i.options.getSubcommand();
      if (action === 'configurar') {
        const role = i.options.getRole('equipe',true);
        const category = i.options.getChannel('categoria',true);
        const log = i.options.getChannel('registros',true);
        if (role.id === i.guildId || log.permissionsFor(i.guild.roles.everyone)?.has(Permission.ViewChannel)) {
          return await privateReply(i,'Escolha um cargo específico e um canal de registros privado.');
        }
        db.prepare('INSERT INTO settings VALUES(?,?,?,?) ON CONFLICT(guild) DO UPDATE SET role=excluded.role,category=excluded.category,logs=excluded.logs')
          .run(i.guildId,role.id,category.id,log.id);
        return await privateReply(i,translated(i,'Central configurada.',"Support desk configured."));
      }
      if (!config) return await privateReply(i,translated(i,'Use /tkt configurar primeiro.',"Run /tkt configure first."));
      if (action === 'painel') {
        const area = i.options.getString('area',true).trim();
        if (!area) return await privateReply(i,translated(i,'Informe uma área válida.',"Enter a valid area."));
        const body = i.options.getString('mensagem')?.trim() || 'Use o botão para explicar o que aconteceu e abrir um atendimento privado.';
        await i.deferReply({flags:MessageFlags.Ephemeral});
        await i.channel.send({embeds:[card(area,body)],components:[buttons(['v:open',translated(i,'Abrir ticket','Open ticket'),ButtonStyle.Primary])],allowedMentions:allowed});
        return i.editReply(translated(i,'Painel publicado.',"Panel published."));
      }
      const row = db.prepare('SELECT COUNT(*) total, COUNT(closed) closed, AVG(rating) average FROM tickets WHERE guild=?').get(i.guildId);
      return await privateReply(i,'Abertos **'+(row.total-row.closed)+'** · Encerrados **'+row.closed+'** · Avaliação média **'+(row.average?.toFixed(1)??'—')+'**');
    }
    const choice=i.isStringSelectMenu?.()&&i.customId.startsWith('v:choose:');
    if(choice||i.isButton()&&i.customId.startsWith('v:open:')){
      const source=choice?panelFromDb(db,i.guildId,i.customId.slice(9)):null;
      const chosen=choice?i.values[0]:i.customId.slice(7);
      if(choice&&(!source||![source.id,...(source.rules.presentation?.links??[])].includes(chosen)))
        return await privateReply(i,translated(i,'O menu mudou. Peça à equipe para publicar o painel novamente.','The menu changed. Ask staff to publish the panel again.'));
      if(!config)return await privateReply(i,translated(i,'A central ainda não foi configurada.','The support desk is not configured yet.'));
      const panel=panelFromDb(db,i.guildId,chosen);
      if(!panel)return await privateReply(i,translated(i,'Este painel está indisponível.','This panel is unavailable.'));
      checkAvailability(i,panel);
      return await i.showModal(panelModal(i,panel));
    }
    if(i.isModalSubmit()&&i.customId.startsWith('v:form:')){
      const [, ,id,version]=i.customId.split(':');
      const panel=config&&panelFromDb(db,i.guildId,id);
      if(!panel||revision(panel)!==version)return await privateReply(i,translated(i,'O formulário mudou. Abra o painel novamente.','The form has changed. Open the panel again.'));
      await i.deferReply({flags:MessageFlags.Ephemeral});
      return await openTicket(i,config,panel);
    }
    if (i.isButton() && i.customId === 'v:open') {
      if (!config) return await privateReply(i,translated(i,'A central ainda não foi configurada.',"The support desk is not configured yet."));
      const area = i.message.embeds[0]?.title;
      if (!area) return await privateReply(i,'Publique este painel novamente.');
      const description = new TextInputBuilder().setCustomId('description').setLabel(translated(i,'Descreva seu pedido','Describe your request')).setStyle(TextInputStyle.Paragraph).setMaxLength(1800).setRequired(true);
      return await i.showModal(new ModalBuilder().setCustomId('v:intake').setTitle((translated(i,'Abrir','Open')+' · '+area).slice(0,45))
        .addComponents(new ActionRowBuilder().addComponents(description)));
    }
    if (!config) return;
    if (i.isModalSubmit() && i.customId === 'v:intake') {
      await i.deferReply({flags:MessageFlags.Ephemeral});
      return await openTicket(i,config);
    }
    if(i.isButton()&&['v:renomear','v:encerrar'].includes(i.customId))return await ticketActionModal(i,config,i.customId.slice(2));
    if(i.isModalSubmit()&&['v:action:renomear','v:action:encerrar'].includes(i.customId))return await manage(i,config,i.customId.slice(9));
    if (i.isChatInputCommand() && i.commandName === 'ticket') return await manage(i,config,i.options.getSubcommand());
    if(i.isButton()&&/^v:close-(?:yes|no):/.test(i.customId)){
      const [,action,id]=i.customId.split(':');
      return await manage(i,config,action,id);
    }
    if (i.isButton() && ['v:assumir','v:solicitar-fechamento'].includes(i.customId)) return await manage(i,config,i.customId.slice(2));
  } catch (error) {
    const message = error.constructor === Error && !error.code ? error.message : translated(i,'O Discord recusou a operação. Verifique as permissões do bot.',"Discord rejected the action. Check the bot permissions.");
    console.error(error);
    const response = i.deferred ? i.editReply(message) : i.replied ? Promise.resolve() : privateReply(i,message);
    await response.catch(console.error);
  }
});
client.on(Events.MessageCreate,message=>{
  if(!message.guildId||message.author.bot||!message.member)return;
  try{
    const config=settings(message.guildId);
    if(!config||!message.member.permissions.has(Permission.ManageGuild)&&![config.role,panelRole(message.channelId)].some(role=>role&&message.member.roles.cache.has(role)))return;
    const ticket=getTicket(message.channelId);
    if(!ticket||ticket.closed!==null||message.author.id===ticket.owner||message.createdTimestamp<ticket.opened)return;
    db.prepare("INSERT OR IGNORE INTO ticket_events VALUES(?,?, 'reply', ?)").run(message.guildId,message.channelId,message.createdTimestamp);
  }catch(e){console.error('TKT telemetry:',e.name)}
});
await client.login(DISCORD_TOKEN);
