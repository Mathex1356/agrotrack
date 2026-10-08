# API de fazendas — Sprint 2, Tarefa 01

Primeiro CRUD parcial sobre Farm existente. Não altera schema, migrations,
PostGIS, catálogo de Permission ou frontend. Sem DELETE físico.

## Contrato e autorização

Todas as rotas exigem access JWT Bearer e `X-Organization-Membership-Id`, validado
pelos guards de autenticação/contexto. O header solicita contexto, não concede
acesso. Organization vem exclusivamente de CurrentContext.

| Rota | Permission | Resultado |
| --- | --- | --- |
| POST /farms | farms.manage | 201, fazenda criada ACTIVE no tenant atual |
| GET /farms | farms.read | 200, página de fazendas territorialmente autorizadas |
| GET /farms/:id | farms.read | 200, detalhe autorizado |
| PATCH /farms/:id | farms.manage | 200, campos alterados da fazenda autorizada |

OWNER tem território org-wide, mas continua precisando da Permission. Outros
papéis exigem FarmMembership ACTIVE do membership atual; nenhum nome de papel
concede capacidade implicitamente. MANAGER/AGRONOMIST padrão podem ler fazendas
atribuídas, mas não criá-las/alterá-las. WORKER padrão recebe 403 nestas leituras:
`farms.read_assigned_work` não equivale a `farms.read`. Um futuro endpoint de
trabalho deverá oferecer projeção limitada e validar a atribuição da atividade.

POST é operação organizacional e não exige vínculo com uma fazenda ainda
inexistente. Não cria FarmMembership automaticamente: um não OWNER que possua
farms.manage não ganha território sobre a nova fazenda por tê-la criado.

`AuthorizationService.authorizedFarmWhere(context, permission, db?)` revalida
identidade, contexto e capacidade e devolve filtro Prisma de tenant/território.
FarmsService combina o filtro por AND com o ID; listagens já filtram no banco,
sem buscar fazendas globais para filtrar em memória. O cliente transacional
opcional permite as mesmas verificações durante o PATCH. A regra OWNER/vínculo
fica centralizada no módulo de autorização, sem duplicação no CRUD.

## Entrada e resposta

POST exige `code`, `name`, `municipality`, `state`, `country`, `timezone`,
`totalAreaHa`, `productiveAreaHa`. Opcionais: `legalOwnerName`, `locationText`,
`description`; null limpa um opcional no PATCH. PATCH aceita qualquer subconjunto
não vazio desses campos e `status` ACTIVE/INACTIVE. POST não aceita status:
sempre cria ACTIVE. Não há default silencioso de país, município ou timezone.

Allowlist rejeita campos desconhecidos/protegidos, inclusive organizationId, id,
timestamps e relações. Strings têm trim, não são vazias e rejeitam controles.
Limites: code 64, name/municipality 160, state 80, country 2, timezone 100,
legalOwnerName 200, locationText 500, description 2000 caracteres. Code e country
são normalizados em maiúsculas; country exige duas letras e timezone é validado
contra a base disponível no Intl do Node. Isto não valida endereço ou posse legal.

Áreas entram exclusivamente como strings decimais, até 12 dígitos inteiros e seis
casas, sem expoente, sinal, espaços, NaN, infinito, número JSON ou arredondamento
silencioso. Exemplo: `"100.123456"`. Regras: total > 0 e 0 <= produtiva <= total.
No PATCH, comparar valores recebidos com os demais valores atuais do banco, usando
Prisma.Decimal. Não converter hectares em Number. Respostas serializam Decimal
como string e datas como ISO; incluem somente campos cadastrais, id e timestamps,
sem organizationId, relações, memberships ou dados de autenticação.

Exemplo POST:

```json
{
  "code": "SANTA-FE",
  "name": "Fazenda Santa Fé",
  "municipality": "Rio Verde",
  "state": "GO",
  "country": "BR",
  "timezone": "America/Sao_Paulo",
  "totalAreaHa": "100",
  "productiveAreaHa": "80"
}
```

GET lista aceita somente `limit` (1–100, padrão 20) e `offset` (0–10000, padrão 0).
Ordena por id ASC e lê limit+1 para retornar `{ items, limit, offset, hasMore }`.
Não retorna total global. Fazendas inativas autorizadas permanecem visíveis para
histórico. Demais rotas não aceitam query parameters. Paginação por offset não é
snapshot: inserções/exclusões administrativas concorrentes podem deslocar páginas.

## Atualização, concorrência e histórico

PATCH executa transação curta: verifica escopo, bloqueia Farm por tenant+id com
SQL parametrizado, revalida autorização e relê a linha após o lock. Mescla áreas
atuais para validar invariantes, mas grava somente campos enviados; PATCHs de
campos diferentes não sobrescrevem uns aos outros com snapshots antigos.
Conflitos no mesmo campo seguem a última transação que obtiver o lock, sem ETag.

Reduzir totalAreaHa abaixo da soma atual de Field ACTIVE recebe 409. A soma é lida
sob lock da Farm, mas isto **não é enforcement global** de soma de talhões: futuros
escritores de Field deverão seguir o mesmo protocolo Farm→Field ou uma proteção
equivalente. A API não cria/edita Field, nem altera sua capacidade individual ou
geometria. Não alegar proteção contra SQL externo que ignore o protocolo.

Inativar Farm preserva Field, Season, Planting e FarmMembership; não remove filhos
nem apaga fatos. Reactivação usa o mesmo PATCH autorizado. AuditLog físico ainda
não existe; nenhum evento de auditoria é inventado ou descartado silenciosamente.

## Erros, transporte e limites

- 400: formato/campo/query/área inválida.
- 401: identidade/sessão ausente ou inválida.
- 403: contexto ou Permission negados.
- 404: ID malformado, inexistente ou fora do território/tenant autorizado, com
  mesma resposta. Nunca consultar globalmente para revelar a existência.
- 409: código duplicado no tenant, conflito transacional conhecido ou redução
  incompatível com os talhões ativos. Erros Prisma/SQL não vão a DTOs ou logs.

CORS permite PATCH apenas nas origens configuradas, mantendo os headers explícitos.
Rotas farms usam Bearer, não refresh cookie; proteção CSRF de auth permanece
inalterada. Frontend não é fronteira de segurança.

Não há RLS nesta etapa. Revogação é revalidada em novas requisições e após espera
pelo lock no PATCH, mas não cancela atomicamente trabalho já iniciado. Futuro
gerenciamento de acessos precisa protocolo para revogação concorrente forte.
Não há novos fluxos de convite, permissão customizada, mapa ou CRUD agrícola.

## Validação

`farms.integration.test.mjs` usa controllers e banco reais. Cenários comuns usam
rollback, inclusive papéis protegidos; caso concorrente usa dados exclusivos com
papel customizado removível e cleanup. Testa autenticação/contexto, capabilities,
tenant/território, OWNER, WORKER, dados inválidos, DTOs, Decimal, histórico,
paginação, CORS e PATCH concorrente. A suíte anterior continua cobrindo SQL,
PostGIS, auth e authorization.
