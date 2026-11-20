# TKT

Bot de tickets para Discord com site e dashboard em Português (Brasil) e English. O dashboard usa OAuth2 e divide dados por servidor. O bot e o dashboard usam o mesmo arquivo SQLite.

## Instalação

1. Use Node.js 24 ou superior e instale as dependências com `npm ci`.
2. No [Discord Developer Portal](https://discord.com/developers/applications), crie a aplicação **TKT**. Ative **Message Content Intent** na aba **Bot**.
3. Instale no servidor de testes com os escopos `bot` e `applications.commands`. Conceda **Gerenciar canais**, **Gerenciar cargos**, **Ver canais**, **Enviar mensagens**, **Inserir links**, **Anexar arquivos** e **Ler histórico de mensagens**.
4. Copie `.env.example` para `.env`. Preencha o token do bot e o ID do servidor de testes. Em **OAuth2**, obtenha o Client ID e Client Secret, cadastre exatamente `http://127.0.0.1:4310/auth/callback` como redirect e preencha os dois campos no `.env`.
5. Abra dois terminais na mesma pasta. No primeiro, execute `npm start`. No segundo, execute `npm run dashboard`.
6. Abra <http://127.0.0.1:4310/>, entre com Discord e selecione um servidor que você administre. Configure o cargo de suporte, a categoria e um canal de registros privado. Salve um painel, selecione o canal de publicação e publique. Use uma conta sem permissões administrativas para verificar o formulário e o canal privado.

### Windows com o Node portátil

```powershell
Set-Location -LiteralPath 'C:\Outros\Dev Projects\TKT'
& '.\.runtime\node-v24.22.3-win-x64\node.exe' --env-file-if-exists=.env bot.mjs
```

Em outro PowerShell:

```powershell
Set-Location -LiteralPath 'C:\Outros\Dev Projects\TKT'
& '.\.runtime\node-v24.22.3-win-x64\node.exe' --env-file-if-exists=.env dashboard.mjs
```

Para atualizar uma instalação existente, pare os processos, faça uma cópia do banco e do `.env`, copie os arquivos da nova versão na pasta do TKT e reinicie. O bot cria as tabelas e os gatilhos de métricas ao abrir o banco existente.

## Operação

- O dashboard oferece seleção de servidor, fila com busca por área e estado, configuração, publicação de painéis e Analytics.
- A equipe administra o ticket com **Assumir**, **Encerrar** e os comandos de prioridade, participantes, reabertura e transcrição no Discord.
- Use a preferência de idioma no dashboard para trocar toda a interface. Em configuração, o idioma do servidor controla os textos principais do bot. Os nomes ingleses dos comandos aparecem para clientes Discord configurados em inglês.
- Analytics soma atividade diária em UTC. Para atribuição e primeira resposta, mostra a mediana, o P90 e o número de tickets medidos. O bot passa a registrar esses eventos após a atualização. O P90 é o menor tempo que cobre pelo menos 90% da amostra. Os novos encerramentos ficam no histórico mesmo após reabertura.

## Site e hospedagem

O site estático está em `docs/`. O GitHub Pages publica a partir de `main` → `/docs`. O dashboard estático abre em modo demonstração. O dashboard com dados reais roda no processo Node.js com OAuth2. Para acesso remoto use HTTPS com proxy reverso na frente do processo, ajuste `DASHBOARD_ORIGIN` para a origem pública e cadastre o callback correspondente. Mantenha o SQLite em armazenamento persistente e execute uma instância do bot por banco.

## FAQ e relatórios avançados

Na aba **FAQ**, escreva uma pergunta e uma resposta, selecione o idioma e marque **Disponível no Discord** quando estiver pronta. No Discord, use `/faq` com busca opcional e escolha de idioma. O bot responde de forma privada e retorna até três respostas publicadas daquele servidor.

A aba **Analytics** inclui um mapa de demanda por dia e hora em UTC, a distribuição por idade da fila atual e a taxa de reabertura. A taxa divide os tickets únicos reabertos após um encerramento no período pelos tickets únicos com encerramento registrado no período. A idade da fila inclui tickets abertos antes do período selecionado. O histórico de reaberturas começa quando o bot com a coleta de eventos é iniciado.
