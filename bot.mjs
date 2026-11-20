import {
  Client, Events, GatewayIntentBits, PermissionFlagsBits as Permission,
  ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, SlashCommandBuilder, LabelBuilder, StringSelectMenuBuilder,
  AttachmentBuilder, MessageFlags,
} from 'discord.js';
import { DatabaseSync } from 'node:sqlite';
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
  ['assumir','Assuma ou devolva o ticket à fila'], ['encerrar','Arquive o atendimento e gere o registro'],
  ['reabrir','Restaure o acesso do solicitante'], ['historico','Exporte a conversa em texto'],
  ['adicionar','Conceda acesso a um participante'], ['remover','Revogue o acesso de um participante'],
  ['prioridade','Atualize a prioridade'],
]) {
  tickets.addSubcommand(cmd => {
    cmd.setName(name).setDescription(description);
    if (name === 'adicionar' || name === 'remover') cmd.addUserOption(o => o.setName('membro').setDescription('Participante').setRequired(true));
    if (name === 'prioridade') cmd.addStringOption(o => o.setName('nivel').setDescription('Prioridade').setRequired(true)
      .addChoices(...['baixa','normal','alta','urgente'].map(value => ({name:value,value}))));
    return cmd;
  });
}
// Ratings are collected through a button sent to the requester in DM.
const commandData = tickets.toJSON();
const words = {
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
    "Claim a ticket or return it to the queue"
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
  return (panel.rules.questions??[]).flatMap((question,index)=>{
    const id='q'+index;
    let value='';
    if(i.fields.fields.has(id)){
      value=question.kind==='choice'?(question.options[Number(i.fields.getStringSelectValues(id)[0])]??''):i.fields.getTextInputValue(id).trim();
    }
    if(question.required&&!value)throw new Error(translated(i,'Preencha as perguntas obrigatórias.','Answer the required questions.'));
    return value?[{name:question.label,value}]:[];
  });
}
const buttons = (...items) => new ActionRowBuilder().addComponents(items.map(([id,label,style]) =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style)));
const card = (title, description) => new EmbedBuilder().setColor(0x9a62e7).setTitle(title).setDescription(description);
const allowed = { parse: [] };

async function transcript(channel) {
  const pages = [];
  let before;
  for (;;) {
    const page = await channel.messages.fetch({limit:100, before, cache:false});
    if (!page.size) break;
    pages.push([...page.values()]);
    if (page.size < 100) break;
    before = page.last().id;
  }
  const lines = pages.flat().reverse().map(message => {
    const files = [...message.attachments.values()].map(file => file.url).join(' ');
    const embeds = message.embeds.map(embed => [embed.title, embed.description, ...embed.fields.map(f=>f.name+': '+f.value)].filter(Boolean).join('\n')).join('\n');
    return '[' + message.createdAt.toISOString() + '] ' + message.author.username + ' (' + message.author.id + ')\n' +
      [message.content, embeds, files].filter(Boolean).join('\n');
  });
  return new AttachmentBuilder(Buffer.from(lines.join('\n\n')), {name:'ticket-' + channel.id + '.txt'});
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
    const answers=hasForm?panelAnswers(i,panel):[];
    const category=panel?.rules.category||config.category;
    const supportRoles=[...new Set([config.role,panel?.rules.role].filter(Boolean))];
    const name = ('ticket-' + i.user.username).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0,85);
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
      await channel.send({
        ...(warning?{content:warning}:{}),
        embeds:[card(area,description).addFields({name:translated(i,'Solicitante','Requester'),value:'<@'+i.user.id+'>'},...answers)],
        allowedMentions:allowed, components:[buttons(
          ['v:assumir',translated(i,'Assumir / liberar','Claim / release'),ButtonStyle.Primary],
          ['v:encerrar',translated(i,'Encerrar','Close'),ButtonStyle.Secondary],
        )],
      });
    } catch (error) {
      db.prepare('DELETE FROM ticket_panel_routes WHERE channel=?').run(channel.id);
      db.prepare('DELETE FROM tickets WHERE channel=?').run(channel.id);
      await channel.delete('Falha na abertura do ticket').catch(console.error);
      throw error;
    }
    return i.editReply(translated(i,'Seu atendimento está em','Your ticket is in')+' <#'+channel.id+'>.');
  });
}

async function manage(i, config, action) {
  await i.deferReply({flags:MessageFlags.Ephemeral});
  return exclusive(i.channelId, async () => {
    const record = getTicket(i.channelId);
    if (!record || record.guild !== i.guildId) throw new Error('Este canal não é um ticket do TKT.');
    const staff = canManage(i,config);
    if (!staff && !(i.user.id === record.owner && action === 'encerrar')) throw new Error(translated(i,'Ação reservada à equipe de suporte.',"Only support staff can do that."));
    const channel = i.channel;
    if (action === 'historico') return i.editReply({files:[await transcript(channel)]});
    if (action === 'reabrir') {
      if (!record.closed) throw new Error(translated(i,'Este ticket já está aberto.',"This ticket is already open."));
      return exclusive('open:' + i.guildId + ':' + record.owner, async () => {
        const current = db.prepare('SELECT channel FROM tickets WHERE guild=? AND owner=? AND closed IS NULL').get(i.guildId,record.owner);
        if (current) throw new Error(translated(i,'O solicitante já possui outro ticket aberto.',"The requester already has another open ticket."));
        await channel.permissionOverwrites.edit(record.owner,{ViewChannel:true,SendMessages:true,ReadMessageHistory:true},{type:1});
        db.prepare('UPDATE tickets SET closed=NULL, rating=NULL WHERE channel=?').run(channel.id);
        return i.editReply(translated(i,'Ticket reaberto.',"Ticket reopened."));
      });
    }
    if (record.closed) throw new Error(translated(i,'Este atendimento já foi encerrado.',"This ticket is already closed."));
    if (action === 'encerrar') {
      const log = await i.guild.channels.fetch(config.logs);
      if (log.id === channel.id || !log.isTextBased()) throw new Error('Configure um canal separado para os registros.');
      if (log.permissionsFor(i.guild.roles.everyone)?.has(Permission.ViewChannel)) throw new Error(translated(i,'O canal de registros precisa ser privado.',"The log channel must be private."));
      const file = await transcript(channel);
      await channel.permissionOverwrites.edit(record.owner,{ViewChannel:false,SendMessages:false},{type:1});
      try {
        await log.send({content:'Ticket **'+channel.id+'** encerrado por <@'+i.user.id+'>.', files:[file],allowedMentions:allowed});
      } catch (error) {
        await channel.permissionOverwrites.edit(record.owner,{ViewChannel:true,SendMessages:true,ReadMessageHistory:true},{type:1}).catch(console.error);
        throw error;
      }
      const closedAt = Date.now();
      db.prepare('UPDATE tickets SET closed=? WHERE channel=?').run(closedAt,channel.id);
      const requester = await client.users.fetch(record.owner).catch(()=>null);
      if (requester) await requester.send({
        content:translated(i,'Como foi o atendimento em','How was your support experience in')+' **'+i.guild.name+'**?',
        components:[buttons(...[1,2,3,4,5].map(n=>['v:rate:'+channel.id+':'+closedAt+':'+n,String(n),ButtonStyle.Secondary]))],
        allowedMentions:allowed,
      }).catch(()=>{});
      return i.editReply(translated(i,'Ticket encerrado. O histórico foi enviado ao canal de registros.',"Ticket closed. The transcript was sent to the log channel."));
    }
    if (action === 'assumir') {
      if (record.agent && record.agent !== i.user.id && !i.memberPermissions.has(Permission.ManageGuild)) {
        throw new Error(translated(i,'Outro atendente já assumiu este ticket.',"Another staff member has claimed this ticket."));
      }
      const agent = record.agent ? null : i.user.id;
      db.prepare('UPDATE tickets SET agent=? WHERE channel=?').run(agent,channel.id);
      await channel.send({content:agent ? 'Atendimento assumido por <@'+agent+'>.' : 'Ticket devolvido à fila.',allowedMentions:allowed});
      return i.editReply(agent ? translated(i,'Ticket assumido.','Ticket claimed.') : translated(i,'Ticket liberado.','Ticket released.'));
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
    if(i.isButton()&&i.customId.startsWith('v:open:')){
      if(!config)return await privateReply(i,translated(i,'A central ainda não foi configurada.','The support desk is not configured yet.'));
      const panel=panelFromDb(db,i.guildId,i.customId.slice(7));
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
    if (i.isChatInputCommand() && i.commandName === 'ticket') return await manage(i,config,i.options.getSubcommand());
    if (i.isButton() && ['v:assumir','v:encerrar'].includes(i.customId)) return await manage(i,config,i.customId.slice(2));
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
