# TKT

O nome TKT vem das letras destacadas em **T**ic**K**e**T**. Bot de atendimento para Discord com identidade visual roxa. O site em `docs/index.html` inclui uma demonstração local da fila de atendimento. O bot usa Node.js 24, discord.js e SQLite. Execute uma instância por banco de dados.

## Instalação

1. Crie uma aplicação em [Discord Developer Portal](https://discord.com/developers/applications) e obtenha o token do bot. Ative **Message Content Intent** em **Bot** para que o histórico inclua mensagens e anexos. A disponibilidade do intent pode depender de aprovação do Discord.
2. Instale a aplicação no servidor com os escopos `bot` e `applications.commands`. Conceda ao bot **Gerenciar canais**, **Gerenciar cargos** (para editar permissões de canal), **Ver canais**, **Enviar mensagens**, **Inserir links**, **Anexar arquivos** e **Ler histórico de mensagens**. Confira também as permissões na categoria de tickets e no canal de registros.
3. Copie `.env.example` para `.env` e preencha `DISCORD_TOKEN` localmente. Use `DISCORD_GUILD_ID` para registrar os comandos apenas no servidor de desenvolvimento. Sem esse valor, o registro é global. Preserve o arquivo SQLite e seus dados ao reiniciar ou atualizar a hospedagem.
4. Na pasta do projeto, execute `npm ci` e `npm start`.
5. Crie um cargo de suporte, uma categoria e um canal de registros visível somente à equipe. Use `/tkt configurar` e publique o painel com `/tkt painel`.

## Fluxo de atendimento

- O membro clica em **Abrir ticket**, explica o pedido e recebe um canal privado. Há um ticket ativo por membro e servidor.
- A equipe usa `/ticket assumir`, `/ticket prioridade`, `/ticket adicionar` e `/ticket remover` para organizar o atendimento.
- A equipe pode exportar a conversa com `/ticket historico`. Ao encerrar, o bot retira o acesso do solicitante, preserva o canal para a equipe e envia a transcrição ao canal de registros. Participantes convidados mantêm as permissões concedidas pela equipe até serem removidos.
- O solicitante pode avaliar o atendimento por mensagem direta, se aceitar DMs. A equipe pode reabrir o canal com `/ticket reabrir` e consultar o panorama com `/tkt fila`.
- O histórico registra URLs de anexos. Para retenção duradoura dos arquivos, será preciso armazenar os próprios anexos.

## Escopo da versão

O site apresenta o produto e permite testar a fila com dados fictícios. Login via Discord, atendimento sincronizado na web e configuração pelo navegador fazem parte da próxima etapa.

O escopo de paridade inclui ainda painéis com vários destinos e menus, formulários configuráveis, roteamento e transferência, horários e regras de inatividade, transcrições pesquisáveis com compartilhamento temporário, candidaturas, FAQ, automações e OCR, recursos de IA, verificação e proteção contra spam, boas-vindas, sorteios, enquetes, métricas detalhadas, Components V2, variáveis, integrações e configurações avançadas de marca e acesso.

Referências de produto e API

- [Documentação do Tickety](https://tickety.top/docs)
- [Documentação do Tickets](https://docs.tickets.bot/)
- [Comandos de aplicação do Discord](https://docs.discord.com/developers/docs/interactions/slash-commands)
