# AgroTrack

Fundação do monorepo — Sprint 0, Tarefa 01.

O AgroTrack será uma plataforma SaaS de gestão e monitoramento agrícola,
multi-organização e multi-fazenda. Esta entrega contém apenas a infraestrutura
inicial dos projetos, sem funcionalidades de negócio.

## Estrutura

```text
apps/
  web/       React + TypeScript + Vite
  api/       NestJS + TypeScript, API REST
packages/    Reservado para futuros pacotes compartilhados
docs/        Reservado para documentação
docker/      Reservado para infraestrutura futura
```

O npm gerencia os workspaces `apps/*` e `packages/*` com um único
`package-lock.json` na raiz. Os pacotes são privados para evitar publicação
acidental. Execute os comandos abaixo na raiz do repositório.

## Requisitos e instalação

- Node.js 24 LTS (24.15.0 ou superior na série 24) e npm 11 ou superior.

```sh
npm ci
```

O lockfile registra as versões instaladas. Para alterar dependências, use
`npm install` com `--workspace=@agrotrack/web` ou `--workspace=@agrotrack/api`.
O cache do npm fica em `.npm-cache/`, ignorado pelo Git.

## Desenvolvimento local

Em um terminal, execute o frontend:

```sh
npm run dev:web
```

Abra <http://localhost:5173>. A página inicial exibe apenas “AgroTrack”.

Em outro terminal, execute a API:

```sh
npm run dev:api
```

A API escuta em `127.0.0.1:3000`. O endpoint
<http://127.0.0.1:3000/health> responde HTTP 200 com:

```json
{ "status": "ok" }
```

Os dois servidores recarregam alterações durante o desenvolvimento.

### Variáveis de ambiente

Nenhum arquivo `.env` é obrigatório para iniciar. Para personalizar a porta da
API, copie `.env.example` para `.env` na raiz e ajuste `PORT`:

```powershell
Copy-Item .env.example .env
```

A API carrega esse arquivo com o suporte nativo do Node.js, preservando as
variáveis já definidas no processo. O frontend não precisa de variáveis nesta
tarefa. Futuras variáveis `VITE_*` serão públicas no navegador; nunca devem
conter segredos. Arquivos `.env` locais são ignorados pelo Git.

## Configurações iniciais

- TypeScript estrito nos dois aplicativos.
- React Router com a rota `/` e TanStack Query com `QueryClientProvider`.
- Tailwind CSS pelo plugin do Vite e importação em `src/styles.css`.
- React Hook Form, Zod e `@hookform/resolvers` disponíveis em
  `apps/web/src/lib/forms.ts`. Os futuros formulários podem utilizar
  `useForm({ resolver: zodResolver(schema) })`; nenhum formulário de negócio
  foi criado.
- NestJS com um módulo raiz e um controller de saúde. O endpoint informa
  somente que o processo HTTP está operacional, sem verificar serviços externos.
- ESLint compartilhado na raiz, com regras TypeScript e React.

## Validação e build

```sh
npm run build
npm run lint
```

Também é possível compilar separadamente:

```sh
npm run build:web
npm run build:api
```

Os resultados ficam em `apps/web/dist` e `apps/api/dist`. Após o build:

```sh
npm run preview --workspace=@agrotrack/web
npm run start --workspace=@agrotrack/api
```

O preview do Vite é apenas para inspeção local do build, não para hospedagem
em produção. O deploy da SPA deverá encaminhar as rotas do navegador para
`index.html` quando forem adicionadas outras páginas.

## Limites desta entrega

Autenticação, autorização, RBAC, isolamento por organização/fazenda e auditoria
serão implementados em tarefas futuras. Esta fundação ainda não é uma aplicação
pronta para produção. Não há banco de dados, Prisma, mapas, módulos de negócio
ou configuração Docker. Os diretórios reservados contêm apenas `.gitkeep`.

Referências de configuração: [Vite](https://vite.dev/guide/),
[Tailwind CSS](https://tailwindcss.com/docs/installation/using-vite),
[React Router](https://reactrouter.com/start/declarative/installation) e
[NestJS](https://docs.nestjs.com/first-steps).
"# agrotrack" 
