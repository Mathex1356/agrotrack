# Modelo físico — Sprint 1, Tarefa 02

Implementação inicial de [domain-model.md](./domain-model.md), respeitando D1–D8.
Prisma 7.10.0, PostgreSQL 18 e PostGIS 3.6. Somente persistência e integridade:
não constitui um sistema funcional de usuários ou de autorização.

## Tabelas e estados

| Tabela | Responsabilidade e chaves |
| --- | --- |
| User | Identidade global; UUID; displayName, email, normalizedEmail globalmente único; ACTIVE/BLOCKED; timestamps. Sem organizationId ou credenciais. |
| Organization | Tenant; UUID; nome e referenceCode globalmente único; PROVISIONING (inicial), ACTIVE, SUSPENDED, CLOSED. Sem ownerUserId. |
| Role | Papel por organização; UUID, nome único no tenant, systemCode opcional e status ACTIVE/INACTIVE. |
| Permission | Catálogo global; código textual estável como PK, descrição, escopo ORGANIZATION/FARM, status ACTIVE/INACTIVE. |
| RolePermission | Capacidade concedida; PK roleId/permissionCode e organizationId validado por FK composta. |
| OrganizationMembership | UUID; vínculo durável único organizationId/userId; papel do mesmo tenant; ACTIVE/SUSPENDED/REVOKED; joinedAt, revokedAt, timestamps. |
| Farm | UUID; code único no tenant; dados cadastrais solicitados, legalOwnerName opcional, áreas NUMERIC(18,6), ACTIVE/INACTIVE, timestamps. |
| FarmMembership | UUID; par membro/fazenda único no tenant; ACTIVE/REVOKED, revokedAt e timestamps. Sem papel próprio. |
| Invitation | UUID; email normalizado, papel, convidante e vínculo aceito opcionais; digest único, validade, criação, aceitação e revogação. Nenhum token em claro. |
| InvitationFarm | PK invitationId/farmId; escopo oferecido pelo convite, validado no mesmo tenant. |

Os nove enums são UserStatus, OrganizationStatus, SystemRoleCode, RoleStatus,
PermissionStatus, PermissionScope, OrganizationMembershipStatus, FarmStatus e
FarmMembershipStatus. Invitation não duplica seu estado em um enum: aceito,
revogado, expirado ou pendente são derivados dos timestamps. Expiração é avaliada
com o relógio no futuro fluxo, não com um CHECK volátil usando now().

UUID v4 é gerado pelo PostgreSQL com gen_random_uuid(), inclusive para inserts SQL.
UUID não autoriza acesso. Instantes usam timestamptz(3). updatedAt é atualizado
pelo Prisma; futuros escritores SQL precisam atualizá-lo explicitamente.
Áreas trafegam como Decimal/string, sem conversão crítica para float.

## Integridade declarativa e SQL adicional

Role, OrganizationMembership, Farm e Invitation expõem UNIQUE(organizationId,id).
Isso permite ao PostgreSQL provar o tenant de cada referência, em vez de apenas
armazenar um organizationId sem relação com os demais IDs.

FKs compostas implementadas:

- RolePermission(organizationId,roleId) → Role.
- OrganizationMembership(organizationId,roleId) → Role.
- FarmMembership(organizationId,organizationMembershipId) → OrganizationMembership;
  FarmMembership(organizationId,farmId) → Farm.
- Invitation(organizationId,roleId) → Role; (organizationId,inviterMembershipId)
  e (organizationId,acceptedMembershipId) → OrganizationMembership.
- InvitationFarm(organizationId,invitationId) → Invitation;
  InvitationFarm(organizationId,farmId) → Farm.

As referências opcionais de Invitation usam MATCH SIMPLE: ID nulo dispensa aquela
FK, mas organizationId nunca é nulo e permanece validado por Organization/Role.
Todas as FKs usam RESTRICT em DELETE e UPDATE. Não há cascatas destrutivas.
Índices cobrem as referências compostas, consulta de membros por User, fazendas
por tenant/status, convites por tenant/email e validade.

Checks manuais na migration:

- User.normalizedEmail = lower(btrim(email)), não vazio; Invitation.normalizedEmail
  também exige lower/trim. Não se removem pontos, aliases ou sufixos do provedor.
- referenceCode e Farm.code são não vazios e armazenados em upper/trim. A
  unicidade de Farm.code é por organização; códigos iguais entre tenants são válidos.
- totalAreaHa > 0; productiveAreaHa >= 0 e <= totalAreaHa; NaN explicitamente
  rejeitado. NUMERIC(18,6) também limita magnitude e precisão.
- RevokedAt presente se e somente se membership está REVOKED; data não anterior
  ao joinedAt (organização) ou createdAt (fazenda). Reativação reutiliza o vínculo,
  limpa revokedAt; histórico completo de transições dependerá da auditoria futura.
- Convite exige digest não vazio, expiresAt > createdAt, acceptedAt e
  acceptedMembershipId juntos, aceitação dentro da validade, sem aceitação e
  revogação simultâneas; revokedAt não anterior à criação.
- Papel de sistema deve permanecer ACTIVE.

SystemRoleCode é enum nullable: OWNER, MANAGER, AGRONOMIST, WORKER. UNIQUE por
organizationId/systemCode permite uma ocorrência de cada código e múltiplos
NULL para futuros papéis customizados. O trigger pequeno protect_system_role
impede troca de systemCode (inclusive NULL ↔ reservado), alteração de ID/tenant
do papel reservado e sua exclusão. O nome é um rótulo, não identidade de segurança.
Não há trigger do último OWNER. Restrições SQL/trigger precisam ser preservadas
e revisadas nas próximas migrations, pois não são representadas pelo schema Prisma.

A proteção estrutural não autoriza INSERT de papéis reservados nem impede um
escritor privilegiado de editar RolePermission. Esses caminhos serão restritos
ao provisionamento e à política de papéis protegidos na aplicação; não existem
fluxos públicos nesta entrega. Customização não está habilitada no MVP.

## Catálogo mínimo e matriz

Os códigos usam plural do recurso e ação estável. Cada linha abaixo representa
uma ou mais Permission persistidas. OWNER recebe todo o catálogo, sempre limitado
à própria organização; nunca é administrador universal.

| Código(s) | Escopo | Outros papéis padrão |
| --- | --- | --- |
| organization.manage, members.manage, roles.manage, farms.manage | ORGANIZATION | Nenhum |
| farms.read | FARM | MANAGER, AGRONOMIST |
| farms.read_assigned_work | FARM | WORKER |
| fields.manage, seasons.manage, plantings.manage | FARM | MANAGER, AGRONOMIST (escopo técnico) |
| activities.plan, activities.execute | FARM | MANAGER |
| activities.plan_technical, activities.execute_technical | FARM | AGRONOMIST |
| activities.execute_assigned | FARM | WORKER |
| inventory.receive, inventory.adjust, inventory.transfer | FARM | MANAGER |
| inventory.consume_via_activity | FARM | MANAGER, AGRONOMIST, WORKER |
| harvest.record | FARM | MANAGER, AGRONOMIST |
| harvest.record_assigned | FARM | WORKER |
| operations.reverse, costs.read, audit.read_farm | FARM | MANAGER |
| audit.read | ORGANIZATION | Nenhum |
| audit.read_technical | FARM | AGRONOMIST |

São 25 capacidades; nomes de domínios futuros no catálogo não criam suas tabelas.
members.manage cobre convites e concessões territoriais; roles.manage não permite
alterar papéis protegidos nem personalização antes da sua implementação.
RolePermission concede capacidade, nunca território. MANAGER/AGRONOMIST/WORKER
dependem de FarmMembership ativo. OWNER não precisa desses vínculos redundantes.
WORKER registra consumo e produção somente por atividade atribuída e autorizada.
AGRONOMIST tem restrições técnicas; transferências exigem acesso a ambas as
fazendas. Esses predicados são obrigatórios na aplicação futura, não satisfeitos
apenas pela existência de uma Permission.

## Seed e provisionamento

prisma/seed.mjs executa seedPermissions em transação: upsert dos 25 códigos,
sem apagar capacidades existentes, sem tenants, pessoas ou fazendas demo.
Reexecutar é seguro; o catálogo conhecido tem descrição/escopo/status reconciliados.

prisma/permissions.mjs contém também provisionSystemRoles(tx, organizationId):
recebe um cliente transacional, exige organização existente, cria/reutiliza os
quatro códigos e concede a matriz padrão sem duplicidades. O catálogo deve ser
preparado antes. Não cria OWNER membership, não ativa tenant e não implementa
fluxo de negócio. Não remove concessões extras: não é ferramenta de reparação de
drift. Um futuro fluxo confiável deverá controlar alterações na matriz protegida.

## Regras ainda dependentes da aplicação

- **Último OWNER (D1): enforcement ainda NÃO implementado.** A estrutura suporta
  múltiplos OWNER; uma organização ativa tecnicamente ainda pode ficar sem um.
  Ativação, suspensão/bloqueio de User, revogação/troca de papel e recuperação
  precisam de fluxo transacional que serialize alterações por Organization e
  revalide OWNER ativo. Não basta contar antes de duas requisições concorrentes.
  Implementar junto ao gerenciamento de memberships, com auditoria e testes de
  concorrência, antes de liberar esses fluxos. Somente OWNER autorizado promove
  outro OWNER; recuperação administrativa será separada e auditada.
- Tenant isolation em leituras, prevenção de IDOR, escopo territorial, estados
  ativos, menor privilégio e campos protegidos. FK não substitui autorização ou RLS.
- Aceitação de convite: identidade/email correspondente, digest seguro e uso único,
  validade atual, revalidação de papel/fazendas, criação/reativação de memberships
  e consumo do convite na mesma transação. Reenvio/revogação também requerem
  controle de concorrência. Nenhuma geração/envio/aceitação foi implementada.
- Imutabilidade semântica de tenants/escopos depois de existir histórico. As FKs
  rejeitam relações incoerentes, mas não proíbem toda mudança de parent válido.
- Validação de nomes, país, timezone IANA e formato de email na futura entrada.
  O CHECK de normalização não é um validador completo de email.
- Retenção D8: cadastros com histórico serão inativados. RESTRICT protege relações
  existentes, mas não substitui política de exclusão ou preserva todo fato sem
  dependentes. Política formal de retenção/desidentificação antes da produção.

Não há novas decisões de produto pendentes para este núcleo. Os limites acima
são trabalho posterior explícito, não alegações de enforcement concluído.

## Migration e validação

Migration: 20261002180000_access_core. SQL gerado a partir do schema, revisado,
com checks e proteção de papéis adicionados manualmente, aplicado em transação.
Não usa db push, reset ou remoção do volume. Preserva os objetos PostGIS.

Na raiz, com .env local ignorado e banco iniciado:

```sh
npm run prisma:format
npm run prisma:validate
npm run db:migrate
npm run prisma:generate
npm run db:seed
npm run db:migrations
npm run test:api
npm run lint
npm run build:api
npm run build:web
npm run db:check
```

Os testes model.integration.test.mjs exercitam PostgreSQL real por Prisma e SQL:
criação válida, unicidades, FKs cross-tenant em ambas as pontas, áreas, NaN,
estados, proteção de papéis, RESTRICT e idempotência do catálogo/helper.
Cada cenário usa transação sempre revertida; não deixa fixtures nem apaga dados
preexistentes. Erros são reportados por códigos, sem parâmetros sensíveis.

Fora de escopo: autenticação, autorização executável, endpoints de negócio,
frontend, RLS, auditoria física e demais entidades agrícolas/geoespaciais.
Nenhuma dependência nova é necessária.
