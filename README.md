# AgroTrack

Monorepo npm workspaces — Sprint 0, Tarefas 01 e 02. A fundação contém frontend,
API REST e infraestrutura local PostgreSQL/PostGIS integrada ao Prisma, sem
entidades ou regras de negócio.

## Estrutura

```text
apps/
  web/                         React + TypeScript + Vite
  api/
    prisma/schema.prisma       Datasource e gerador, ainda sem modelos
    prisma.config.ts           Configuração do CLI Prisma
    src/config/                Leitura e validação do ambiente
    src/prisma/                PrismaModule e PrismaService
    src/generated/prisma/      Client gerado, ignorado pelo Git
    scripts/check-database.mjs Verificação real via Prisma
    test/                      Testes de configuração e health
packages/                      Reservado para pacotes compartilhados
docs/                          Reservado para documentação
docker/postgres/               Inicialização da extensão PostGIS
compose.yaml                   Banco local e volume persistente
```

Os workspaces são privados e usam um único `package-lock.json`. Execute todos os
comandos abaixo na raiz do repositório; são compatíveis com Windows/PowerShell.

## Pré-requisitos

- Node.js 24 LTS (24.15.0 ou superior na série 24) e npm 11 ou superior.
- Docker Desktop iniciado, com engine de containers Linux e Docker Compose.
- Porta local 5432 disponível ou outra porta definida em `POSTGRES_PORT`.

A imagem é `postgis/postgis:18-3.6`, mantida pelo projeto PostGIS, baseada no
PostgreSQL 18 com PostGIS 3.6. O volume é montado em `/var/lib/postgresql`, caminho
usado pela imagem PostgreSQL 18. O Prisma CLI, Client e adaptador PostgreSQL
estão alinhados e fixados em 7.10.0; consulte o lockfile para as demais versões.

## Primeira execução

1. Instale as dependências:

   ```sh
   npm ci
   ```

2. Se ainda não existir `.env`, copie o exemplo:

   ```powershell
   Copy-Item .env.example .env
   ```

3. Edite o `.env` na raiz. Substitua `POSTGRES_PASSWORD` por uma senha exclusiva
   do ambiente local e atualize `DATABASE_URL` com a mesma senha, usuário,
   database e porta. Não use credenciais de produção. Não sobrescreva um `.env`
   já configurado. O placeholder do exemplo é rejeitado pela API.

   | Variável | Uso |
   | --- | --- |
   | `PORT` | Porta HTTP da API; padrão 3000 |
   | `POSTGRES_DB` | Database criado no primeiro início do volume |
   | `POSTGRES_USER` | Usuário administrativo exclusivo do banco local |
   | `POSTGRES_PASSWORD` | Senha local obrigatória para o Compose |
   | `POSTGRES_PORT` | Porta publicada em `127.0.0.1` |
   | `DATABASE_URL` | Conexão PostgreSQL usada pela API e pelo CLI Prisma |

   `DATABASE_URL` é uma URL completa, sem interpolação de outras variáveis.
   Caracteres especiais no usuário/senha devem ser codificados para URL
   (por exemplo, `@` vira `%40`). A senha em `POSTGRES_PASSWORD` permanece literal.
   Ao mudar `POSTGRES_PORT`, ajuste também a porta de `DATABASE_URL`.
   A API roda no host, por isso a URL utiliza `127.0.0.1`, não o hostname `db`.

4. Inicie o banco e aguarde o healthcheck:

   ```sh
   npm run db:up
   npm run db:status
   ```

5. Valide e gere o Client Prisma:

   ```sh
   npm run prisma:validate
   npm run prisma:generate
   ```

6. Confirme a conexão Prisma e a extensão PostGIS:

   ```sh
   npm run db:check
   ```

   Esse comando compila a API, executa uma consulta real e mostra as versões
   PostgreSQL/PostGIS. Ele consulta `current_setting('server_version')`,
   `postgis_lib_version()` e `postgis_full_version()`, sem imprimir a conexão ou
   credenciais. Falha com código diferente de zero caso a verificação falhe.

7. Inicie cada aplicação em um terminal:

   ```sh
   npm run dev:api
   ```

   ```sh
   npm run dev:web
   ```

   API: <http://127.0.0.1:3000/health>. Frontend: <http://localhost:5173>.
   `dev:api` e `build:api` geram o Prisma Client automaticamente antes de iniciar.

## Health check

```powershell
Invoke-RestMethod http://127.0.0.1:3000/health
```

Com a conexão funcionando, retorna HTTP 200:

```json
{ "status": "ok", "api": "operational", "database": "connected" }
```

O endpoint executa `SELECT 1` pelo Prisma a cada requisição. Se o banco ficar
indisponível após a inicialização, retorna HTTP 503:

```json
{ "status": "degraded", "api": "operational", "database": "disconnected" }
```

O HTTP público não inclui stack trace, usuário, senha, URL ou detalhes internos.
A verificação de saúde não consulta versões; essa informação fica no comando
local `db:check`. A API valida `DATABASE_URL` antes de iniciar e verifica a conexão
na inicialização. Se faltar configuração ou o banco estiver indisponível, o
processo encerra com uma mensagem segura. Inicie o banco antes da API.

## Uso diário e persistência

```sh
npm run db:up       # Inicia o banco e aguarda o healthcheck
npm run db:status   # Exibe o estado do container
npm run db:logs     # Acompanha os logs; Ctrl+C encerra o acompanhamento
npm run dev:api    # Inicia a API; Ctrl+C encerra
npm run dev:web    # Em outro terminal
npm run db:down     # Para/remove o container e a rede, preservando os dados
```

O volume `agrotrack-local_postgres_data` persiste entre `db:down` e `db:up`.
Não use `docker compose down -v` se quiser manter os dados: `-v` remove o volume.
As variáveis `POSTGRES_DB`, `POSTGRES_USER` e `POSTGRES_PASSWORD` são aplicadas
somente na criação inicial do banco; alterar o `.env` não altera automaticamente
um volume existente. A criação idempotente da extensão em
`docker/postgres/20-postgis.sql` também roda somente no primeiro início.

Para validar uma indisponibilidade manualmente, com a API já em execução:

```sh
docker compose stop db
# Consulte /health: deve retornar 503.
npm run db:up
# Consulte /health novamente: deve retornar 200 sem reiniciar a API.
```

## Prisma e NestJS

O schema está em `apps/api/prisma/schema.prisma`, com datasource PostgreSQL e
nenhum modelo. Não há migrations nesta tarefa e não é necessário executar
`db push`, introspecção ou criar tabelas artificiais para verificar a conexão.
A imagem cria objetos internos da extensão PostGIS; eles não são entidades do
AgroTrack.

O Prisma 7 utiliza `prisma.config.ts` para a URL e `@prisma/adapter-pg` como
driver. O NestJS injeta um único `PrismaService` exportado pelo `PrismaModule`.
Módulos futuros devem importar `PrismaModule`, sem registrar novamente o service
ou criar novos clients. O pool limita conexões e configura timeouts de conexão e
consulta de três segundos. O lifecycle conecta ao iniciar e desconecta ao
encerrar, incluindo os sinais tratados por `enableShutdownHooks()`.

O `.env` é carregado com o suporte nativo do Node.js, preservando variáveis já
definidas no processo. Ele é ignorado pelo Git. O Client gerado também é ignorado
e deve ser regenerado após mudanças no schema ou atualização do Prisma.

## Validação

Com `.env` configurado e banco iniciado:

```sh
npm run prisma:validate
npm run prisma:generate
npm run build
npm run lint
npm run test:api
npm run db:check
```

`test:api` cobre configuração inválida, espera pela consulta e resposta segura de
falha; `db:check` valida a infraestrutura real. Os artefatos de build ficam em
`apps/web/dist` e `apps/api/dist`. Para iniciar o build da API:

```sh
npm run start --workspace=@agrotrack/api
```

## Credenciais e escopo

Não adicione `.env` ao Git, não compartilhe sua `DATABASE_URL` e não use variáveis
`VITE_*` para segredos: essas variáveis ficam públicas no navegador. Evite colar
saídas de `docker compose config` ou inspeções completas de containers, pois
podem conter as variáveis de ambiente. Para conferir a configuração sem exibi-la,
use `docker compose config --quiet`.

O banco é exclusivo do desenvolvimento local, com acesso publicado somente em
loopback; seu usuário inicial é administrativo e não deve ser reutilizado como
usuário da aplicação em produção. Autenticação, autorização, entidades de
negócio, migrations de domínio e configuração de produção permanecem fora desta
entrega. O frontend mantém a página mínima AgroTrack e a stack da Tarefa 01.

O `package.json` raiz contém overrides limitados ao Prisma 7.10.0 para
`deepmerge-ts@8.0.2` e `mysql2@3.24.5`, corrigindo alertas nas versões transitivas
fixadas pelo CLI. MySQL não é usado pela aplicação. O Prisma utiliza `deepmerge`
para configuração com objetos simples; as mudanças de comportamento em Maps da
versão 8 não afetam a configuração atual. Geração, validação e build foram
verificados com esses overrides. Revise-os ao atualizar o Prisma e execute
`npm audit` e as validações novamente.

Referências: [imagem PostGIS](https://github.com/postgis/docker-postgis),
[Prisma com PostgreSQL](https://www.prisma.io/docs/orm/overview/databases/postgresql)
e [geração do Prisma Client](https://www.prisma.io/docs/orm/prisma-client/setup-and-configuration/generating-prisma-client).
