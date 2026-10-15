# API de culturas e safras — Sprint 2, Tarefa 03

Esta etapa expõe os cadastros Crop e Season existentes, sem alterar schema,
migrations, PostGIS ou decisões D1–D8. Não implementa Planting, estoque, transições
operacionais de safra, exclusão, frontend ou permissões customizadas via HTTP.

## Capacidades aprovadas e contexto

Todas as rotas exigem Bearer válido e CurrentContext validado a partir de
`X-Organization-Membership-Id`. IDs recebidos nunca concedem acesso.

| Rotas | Permission | Escopo |
| --- | --- | --- |
| GET /crops e /crops/:id | crops.read | ORGANIZATION; OWNER, MANAGER, AGRONOMIST |
| POST /crops e PATCH /crops/:id | crops.manage | ORGANIZATION; OWNER |
| GET /farms/:farmId/seasons e /:id | farms.read | Farm autorizada |
| POST /farms/:farmId/seasons e PATCH /:id | seasons.manage | Farm autorizada |

WORKER não recebe essas capacidades. OWNER precisa da Permission e possui alcance
territorial apenas na organização corrente; demais papéis precisam também de
FarmMembership ACTIVE. Culturas são catálogo organizacional e não exigem vínculo
com fazenda. Os serviços reutilizam AuthorizationService, sem duplicar o bypass
territorial de OWNER. Revogações são consultadas no banco, sem cache/JWT de grants;
não cancelam retroativamente uma operação já em voo.

## Crop

GET inclui culturas GLOBAL e privadas da organização atual, inclusive INACTIVE.
POST aceita somente `code` e `name`, cria ORGANIZATION/ACTIVE com organizationId
do contexto. PATCH aceita `code`, `name`, `status` (ACTIVE ou INACTIVE), apenas em
culturas privadas da organização corrente. GLOBAL é somente leitura nessas rotas;
suas alterações pertencem à administração da plataforma, não implementada aqui.
PATCH de GLOBAL retorna 404, assim como recurso inexistente ou privado externo.

Scope e organizationId nunca são alteráveis pela API. Crop é cultura agronômica,
não Product de estoque. A inativação preserva referências de Planting. Os CHECKs,
trigger de escopo imutável e índices únicos existentes continuam protegendo o
banco: código global único e código privado único por organização. Nomes não são
globalmente únicos; conflito de código normalizado retorna 409.

## Season

POST aceita `code`, `name`, `startDate`, `expectedEndDate` e fixa PLANNED.
PATCH aceita somente esses quatro campos e exige estado atual PLANNED. `status`
e `actualEndDate` são rejeitados como campos protegidos, não ignorados. IN_PROGRESS,
FINISHED e CANCELLED são consultáveis, mas sua edição cadastral retorna 409. Não
há endpoint de transição de estado nesta etapa. Fazenda INACTIVE permite leitura
histórica e impede criação/edição de safras com 409.

Datas são strings civis estritas `YYYY-MM-DD`, anos 0001–9999, dias reais do
calendário; timestamps, números e rollover de datas inválidas são rejeitados.
Respostas usam esse mesmo formato sem fuso. expectedEndDate deve ser >= startDate.
PATCH combina os campos presentes com os atuais sob lock e valida também
actualEndDate legado, se preenchido, contra a nova data inicial. Safras podem se
sobrepor; nenhuma reserva temporal ou exclusão foi criada. Código é único por
fazenda, conforme constraint existente. FKs compostas tenant/fazenda e RESTRICT
preservam integridade e histórico de plantios.

## Contrato HTTP e concorrência

Bodies são objetos não vazios com allowlists estritas; campos desconhecidos,
IDs, relações, timestamps e organizationId são rejeitados. Código sofre trim e
uppercase, máximo 64 caracteres; nome sofre trim, máximo 160. Ambos são obrigatórios
na criação, não nulos/nem vazios e sem caracteres de controle.

Listas aceitam apenas `limit` (1–100, padrão 20) e `offset` (0–10000, padrão 0),
ordenam por id e retornam `{items, limit, offset, hasMore}` via limit+1. Detail e
mutações não aceitam query parameters. DTOs usam projeção explícita sem
organizationId ou relações internas. Season inclui farmId, datas e status;
Crop inclui scope. UUID inválido, recurso inexistente ou invisível retorna 404.
Uma lista de safra em fazenda invisível também retorna 404, não lista vazia.

401 indica identidade/sessão inválida; 403 indica contexto/capacidade negada;
400 indica input inválido; 409 indica duplicidade/estado incompatível/conflito
transacional; erros internos são sanitizados pelo filtro HTTP existente.

Crop PATCH bloqueia sua linha tenant-scoped e revalida capacidade após esperar.
Season writes bloqueiam Farm antes de Season e revalidam território após espera.
PATCH atualiza somente campos enviados, evitando sobrescrever campos omitidos
por concorrência. Unicidade permanece arbitrada pelo PostgreSQL. Não há RLS,
auditoria de negócio ou cancelamento retroativo de requisições nesta etapa.

## Evolução do seed e provisionamento

O catálogo passa de 25 para 27 Permissions com `crops.read` e `crops.manage`.
`seedPermissions(tx)` introduz cada novo código e seus grants padrão para Roles
de sistema existentes na mesma transação. Esse backfill é restrito aos dois
códigos novos efetivamente inseridos; papéis customizados não recebem grants.
Reexecuções não restauram RolePermissions removidas nem apagam concessões extras.

`provisionSystemRoles(tx, organizationId)` concede a matriz completa somente aos
Roles efetivamente criados naquela chamada. Roles já existentes mantêm suas
concessões e ausências. Ambos os helpers exigem uma transação e compartilham
advisory lock PostgreSQL interno para serializar introdução/provisionamento.
O catálogo é marcador da introdução, não ferramenta de reparação de grants;
deleção/reset manual de Permission não é fluxo suportado. O seed continua
atualizando descrição/escopo/status ACTIVE das capacidades conhecidas, como antes;
não deve ser executado como manutenção durante uma desativação operacional.

## Validação

`test/crops-seasons.integration.test.mjs` usa HTTP Nest real e PostgreSQL, incluindo
isolamento, grants e revogação, datas civis, estados, referências históricas,
duplicidades concorrentes, PATCHs independentes sob locks observados com
pg_blocking_pids e seed/provisionamento concorrentes. Fixtures com papéis protegidos
usam rollback; fixtures concorrentes persistidas usam papéis customizados e limpeza.
