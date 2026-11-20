import {
  Client, Events, GatewayIntentBits, PermissionFlagsBits as Permission,
  ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, SlashCommandBuilder,
  AttachmentBuilder, MessageFlags,
} from 'discord.js';
import { DatabaseSync } from 'node:sqlite';

const { DISCORD_TOKEN, DISCORD_GUILD_ID, DATABASE_PATH = 'tkt.sqlite' } = process.env;
if (!DISCORD_TOKEN) throw new Error('Defina DISCORD_TOKEN no arquivo .env.');
const db = new DatabaseSync(DATABASE_PATH);
db.exec(`
  PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS settings (guild TEXT PRIMARY KEY, role TEXT NOT NULL, category TEXT NOT NULL, logs TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS tickets (
    channel TEXT PRIMARY KEY, guild TEXT NOT NULL, owner TEXT NOT NULL, area TEXT NOT NULL,
    opened INTEGER NOT NULL, closed INTEGER, agent TEXT, priority TEXT NOT NULL DEFAULT 'normal',
    rating INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS one_open_ticket ON tickets(guild, owner) WHERE closed IS NULL;
`);
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.MessageContent] });
const settings = guild => db.prepare('SELECT * FROM settings WHERE guild=?').get(guild);
const getTicket = channel => db.prepare('SELECT * FROM tickets WHERE channel=?').get(channel);
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
const pending = new Set();
async function exclusive(key, work) {
  if (pending.has(key)) throw new Error('Já existe uma operação em andamento. Tente novamente em instantes.');
  pending.add(key);
  try { return await work(); } finally { pending.delete(key); }
}
const privateReply = (i, content) => i.reply({ content, flags: MessageFlags.Ephemeral });
const canManage = (i, config) => i.memberPermissions?.has(Permission.ManageGuild) || i.member?.roles?.cache?.has(config.role);
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
    const embeds = message.embeds.map(embed => [embed.title, embed.description].filter(Boolean).join('\n')).join('\n');
    return '[' + message.createdAt.toISOString() + '] ' + message.author.username + ' (' + message.author.id + ')\n' +
      [message.content, embeds, files].filter(Boolean).join('\n');
  });
  return new AttachmentBuilder(Buffer.from(lines.join('\n\n')), {name:'ticket-' + channel.id + '.txt'});
}

async function openTicket(i, config) {
  return exclusive('open:' + i.guildId + ':' + i.user.id, async () => {
    const existing = db.prepare('SELECT channel FROM tickets WHERE guild=? AND owner=? AND closed IS NULL').get(i.guildId,i.user.id);
    if (existing) {
      const current = await i.guild.channels.fetch(existing.channel).catch(error => {
        if (error.code === 10003) return null;
        throw error;
      });
      if (current) return i.editReply('Você já tem um ticket aberto em <#' + existing.channel + '>.');
      db.prepare('UPDATE tickets SET closed=? WHERE channel=?').run(Date.now(),existing.channel);
    }
    const area = i.message?.embeds[0]?.title?.trim();
    const description = i.fields.getTextInputValue('description').trim();
    if (!area || !description) throw new Error('Preencha a área e a descrição.');
    const name = ('ticket-' + i.user.username).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0,85);
    const channel = await i.guild.channels.create({
      name, type: ChannelType.GuildText, parent:config.category,
      permissionOverwrites:[
        {id:i.guildId, type:0, deny:[Permission.ViewChannel]},
        {id:config.role, type:0, allow:[Permission.ViewChannel,Permission.SendMessages,Permission.ReadMessageHistory]},
        {id:i.user.id, type:1, allow:[Permission.ViewChannel,Permission.SendMessages,Permission.ReadMessageHistory]},
        {id:client.user.id, type:1, allow:[Permission.ViewChannel,Permission.SendMessages,Permission.ReadMessageHistory]},
      ],
    });
    try {
      db.prepare('INSERT INTO tickets(channel,guild,owner,area,opened) VALUES(?,?,?,?,?)')
        .run(channel.id,i.guildId,i.user.id,area,Date.now());
      await channel.send({
        embeds:[card(area,description).addFields({name:'Solicitante',value:'<@'+i.user.id+'>'})],
        allowedMentions:allowed, components:[buttons(
          ['v:assumir','Assumir / liberar',ButtonStyle.Primary],
          ['v:encerrar','Encerrar',ButtonStyle.Secondary],
        )],
      });
    } catch (error) {
      db.prepare('DELETE FROM tickets WHERE channel=?').run(channel.id);
      await channel.delete('Falha na abertura do ticket').catch(console.error);
      throw error;
    }
    return i.editReply('Seu atendimento está em <#'+channel.id+'>.');
  });
}

async function manage(i, config, action) {
  await i.deferReply({flags:MessageFlags.Ephemeral});
  return exclusive(i.channelId, async () => {
    const record = getTicket(i.channelId);
    if (!record || record.guild !== i.guildId) throw new Error('Este canal não é um ticket do TKT.');
    const staff = canManage(i,config);
    if (!staff && !(i.user.id === record.owner && action === 'encerrar')) throw new Error('Ação reservada à equipe de suporte.');
    const channel = i.channel;
    if (action === 'historico') return i.editReply({files:[await transcript(channel)]});
    if (action === 'reabrir') {
      if (!record.closed) throw new Error('Este ticket já está aberto.');
      return exclusive('open:' + i.guildId + ':' + record.owner, async () => {
        const current = db.prepare('SELECT channel FROM tickets WHERE guild=? AND owner=? AND closed IS NULL').get(i.guildId,record.owner);
        if (current) throw new Error('O solicitante já possui outro ticket aberto.');
        await channel.permissionOverwrites.edit(record.owner,{ViewChannel:true,SendMessages:true,ReadMessageHistory:true},{type:1});
        db.prepare('UPDATE tickets SET closed=NULL, rating=NULL WHERE channel=?').run(channel.id);
        return i.editReply('Ticket reaberto.');
      });
    }
    if (record.closed) throw new Error('Este atendimento já foi encerrado.');
    if (action === 'encerrar') {
      const log = await i.guild.channels.fetch(config.logs);
      if (log.id === channel.id || !log.isTextBased()) throw new Error('Configure um canal separado para os registros.');
      if (log.permissionsFor(i.guild.roles.everyone)?.has(Permission.ViewChannel)) throw new Error('O canal de registros precisa ser privado.');
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
        content:'Como foi o atendimento em **'+i.guild.name+'**?',
        components:[buttons(...[1,2,3,4,5].map(n=>['v:rate:'+channel.id+':'+closedAt+':'+n,String(n),ButtonStyle.Secondary]))],
        allowedMentions:allowed,
      }).catch(()=>{});
      return i.editReply('Ticket encerrado. O histórico foi enviado ao canal de registros.');
    }
    if (action === 'assumir') {
      if (record.agent && record.agent !== i.user.id && !i.memberPermissions.has(Permission.ManageGuild)) {
        throw new Error('Outro atendente já assumiu este ticket.');
      }
      const agent = record.agent ? null : i.user.id;
      db.prepare('UPDATE tickets SET agent=? WHERE channel=?').run(agent,channel.id);
      await channel.send({content:agent ? 'Atendimento assumido por <@'+agent+'>.' : 'Ticket devolvido à fila.',allowedMentions:allowed});
      return i.editReply(agent ? 'Ticket assumido.' : 'Ticket liberado.');
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
    return i.editReply('Acesso do participante atualizado.');
  });
}

client.once(Events.ClientReady, async bot => {
  try {
    const commands = [admin.toJSON(), commandData];
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
        return await privateReply(i,'Central configurada.');
      }
      if (!config) return await privateReply(i,'Use /tkt configurar primeiro.');
      if (action === 'painel') {
        const area = i.options.getString('area',true).trim();
        if (!area) return await privateReply(i,'Informe uma área válida.');
        const body = i.options.getString('mensagem')?.trim() || 'Use o botão para explicar o que aconteceu e abrir um atendimento privado.';
        await i.deferReply({flags:MessageFlags.Ephemeral});
        await i.channel.send({embeds:[card(area,body)],components:[buttons(['v:open','Abrir ticket',ButtonStyle.Primary])],allowedMentions:allowed});
        return i.editReply('Painel publicado.');
      }
      const row = db.prepare('SELECT COUNT(*) total, COUNT(closed) closed, AVG(rating) average FROM tickets WHERE guild=?').get(i.guildId);
      return await privateReply(i,'Abertos **'+(row.total-row.closed)+'** · Encerrados **'+row.closed+'** · Avaliação média **'+(row.average?.toFixed(1)??'—')+'**');
    }
    if (i.isButton() && i.customId === 'v:open') {
      if (!config) return await privateReply(i,'A central ainda não foi configurada.');
      const area = i.message.embeds[0]?.title;
      if (!area) return await privateReply(i,'Publique este painel novamente.');
      const description = new TextInputBuilder().setCustomId('description').setLabel('Descreva seu pedido').setStyle(TextInputStyle.Paragraph).setMaxLength(1800).setRequired(true);
      return await i.showModal(new ModalBuilder().setCustomId('v:intake').setTitle(('Abrir · '+area).slice(0,45))
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
    const message = error.constructor === Error && !error.code ? error.message : 'O Discord recusou a operação. Verifique as permissões do bot.';
    console.error(error);
    const response = i.deferred ? i.editReply(message) : i.replied ? Promise.resolve() : privateReply(i,message);
    await response.catch(console.error);
  }
});
await client.login(DISCORD_TOKEN);
