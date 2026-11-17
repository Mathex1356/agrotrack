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

## Complemento — Tarefa 03: núcleo agrícola e geoespacial

A migration `20261002190000_agricultural_core` acrescenta somente Field, Crop,
Season e Planting. A migration `20261002180000_access_core` permanece intacta.
As seções anteriores descrevem a entrega da Tarefa 02; os catálogos e testes
agora incluem também o complemento abaixo. D1–D8 não foram modificadas.

### Modelos, precisão e escopo

| Modelo | Representação física |
| --- | --- |
| Field | UUID, organização/fazenda, code/name, areaHa NUMERIC(18,6), soilType/description/notes opcionais, ACTIVE/INACTIVE, boundary opcional, geometryRevision e timestamps. |
| Crop | UUID, scope GLOBAL/ORGANIZATION, organizationId opcional, code/name, ACTIVE/INACTIVE e timestamps. Não representa produto de estoque. |
| Season | UUID, organização/fazenda, code/name, startDate/expectedEndDate, actualEndDate opcional, PLANNED/IN_PROGRESS/FINISHED/CANCELLED e timestamps. |
| Planting | UUID, organização/fazenda, Field/Season/Crop, variedade opcional, plannedAreaHa/actualAreaHa NUMERIC(18,6), datas previstas/reais, spacingMeters NUMERIC(18,6), populationPerHa NUMERIC(20,6), notes, estado e timestamps. |

Enums adicionados: FieldStatus, CropScope, CropStatus, SeasonStatus e PlantingStatus.
Datas agronômicas são DATE, sem hora; timestamps cadastrais continuam timestamptz(3).
UUIDs continuam v4 gerados no PostgreSQL. Códigos são upper/trim, não vazios e
não são liberados pela inativação. Nomes não são globalmente únicos.

Field não tem cropId: um território pode receber vários Planting simultâneos,
inclusive da mesma Season. Cada Planting associa uma cultura, área e intervalo;
não há UNIQUE(fieldId,seasonId) nem exclusão temporal. Safras sobrepostas são válidas.
Crop é identidade agronômica; Product será o insumo/material com unidades e estoque.

Unit não é necessário para estes quatro modelos. suggestedHarvestUnitCode,
plannedSeedUnit **e sua quantidade associada plannedSeedQuantity** ficam para a
etapa de unidades; não há texto livre de unidade nem quantidade sem dimensão.
areaSource/areaQuality também não foram antecipados: a área oficial nesta fase é
sempre declarada/validada, e não existe vocabulário aprovado de qualidade/origem
de levantamento. Implementá-los junto ao fluxo de validação territorial.

### FKs, checks e índices

- Field e Season → Farm por (organizationId,farmId).
- Field e Season expõem UNIQUE(organizationId,farmId,id).
- Planting → Field por (organizationId,farmId,fieldId), e → Season por
  (organizationId,farmId,seasonId). Impede combinar tenants ou fazendas diferentes.
- Crop privado → Organization; Planting → Crop por ID mais constraint trigger.
- Todas as FKs usam DELETE/UPDATE RESTRICT, sem cascatas. Inativar não apaga filhos.
- Field.areaHa e áreas de Planting são positivas e diferentes de NaN; spacingMeters
  e populationPerHa, quando presentes, também. Escala/magnitude são limitadas por
  NUMERIC. A entrada futura deve rejeitar precisão excedente antes do arredondamento.
- Season: expectedEndDate e actualEndDate não anteriores a startDate. Planting:
  expectedEndDate >= plannedStartDate; actualEndDate exige actualStartDate e não
  pode antecedê-la. Não limitar execução às datas previstas nem impedir sobreposição.
  Transições de status e pré-condições de iniciar/finalizar ainda são de fluxo futuro.
- Field/Season: códigos únicos por organização/fazenda; índices
  (organizationId,farmId,status). Planting: índices
  (organizationId,farmId,fieldId,status), (organizationId,farmId,seasonId,status)
  e cropId. Servem a listagens e checagens de referências; consultas temporais
  futuras podem usar o prefixo por Field sem filtrar apenas o status atual.
- Crop: índice (scope,organizationId,status), UNIQUE(organizationId,code) para
  privados e índice único parcial code WHERE scope='GLOBAL' para globais.
  A chave privada não resolve NULLs globais sozinha. Field.boundary recebe GiST.

### Crop global ou da mesma organização

CHECK exige GLOBAL com organizationId NULL e ORGANIZATION com organizationId
presente. O constraint trigger imediato, não diferível,
`Planting_crop_scope_check` roda em INSERT/UPDATE e só permite Crop global ou da
organização declarada no Planting. IDs incompatíveis produzem erro sem detalhes
de outros tenants. A FK simples mantém existência e RESTRICT.

`Crop_protect_scope` bloqueia mudança de scope/organizationId desde a criação,
conforme seção 5.2 do modelo conceitual. Assim uma cultura não pode ser movida
depois da validação de um vínculo, inclusive durante concorrência. Renomear ou
inativar é permitido, preservando referências. Impedir novos usos de culturas
inativas e autorizar manutenção global somente pela plataforma são validações
do futuro fluxo; o trigger não implementa autorização de usuário nem RLS.

### Field.boundary e área geográfica

No Prisma 7.10.0, `Unsupported("geometry(MultiPolygon,4326)")?` mantém a coluna
no modelo/migration, sem expô-la como campo CRUD comum no Client. Nos testes,
escrita/leitura usam SQL parametrizado; leituras convertem a geometria em dados
suportados. Não foi criado adaptador ou endpoint espacial de negócio.
[Referência Prisma: tipos não suportados](https://docs.prisma.io/docs/orm/reference/prisma-schema-reference).

A migration garante PostGIS com CREATE EXTENSION IF NOT EXISTS antes da coluna,
inclusive em banco novo/shadow com os binários da extensão disponíveis. O usuário
de migration precisa desse privilégio; não deve ser o usuário runtime de produção.
O typmod limita armazenamento a MultiPolygon 2D/SRID 4326. CHECK adicional rejeita
vazio, invalidez topológica e coordenadas fora de longitude [-180,180] e latitude
[-90,90]. ST_IsValid(boundary,0) evita NOTICE com detalhes da geometria inválida.
Não se usa ST_MakeValid nem se armazena GeoJSON paralelo.
[Referência PostGIS: validade](https://postgis.net/docs/ST_IsValid.html).

Comportamentos reais do PostGIS 3.6 cobertos por testes: Polygon é promovido a
MultiPolygon sem mudar a forma (ST_Equals); Point e geometria 3D são rejeitados.
SRID conhecido diferente, como 3857, é rejeitado. O typmod atribui 4326 quando o
SRID de entrada é 0: isso **não transforma coordenadas**, apenas as interpreta
como WGS84. SQL direto deve fornecer longitude/latitude WGS84; o futuro adaptador
deve exigir referência conhecida e transformar importações antes do armazenamento,
sem aceitar coordenadas projetadas apenas porque estão nos limites numéricos.

geometryRevision é mantido pelo banco: 0 na criação sem geometria, 1 com geometria;
incrementa ao alterar os bytes EWKB, inclusive remover boundary. Regravar o mesmo
EWKB não incrementa; alterações manuais do contador são ignoradas. Mudança espacial
também atualiza updatedAt. Revisão não é histórico: snapshots e auditoria futuros
continuam necessários para preservar geometrias utilizadas por fatos confirmados.

areaHa declarada continua oficial. Não existe calculatedAreaHa persistido. Derivar
`ST_Area(boundary::geography) / 10000` quando houver geometria; o teste mede um
retângulo conhecido e verifica hectares plausíveis sem modificar areaHa.
[Referência PostGIS: área em geography](https://postgis.net/docs/ST_Area.html).
Ausência de boundary representa “Talhão ainda não mapeado” na futura interface.
A divergência `abs(calculada-declarada)/declarada*100 > 2` deverá sinalizar revisão;
não há alertas agora nem substituição automática da capacidade.

### Capacidade individual implementada; agregada adiada

`Planting_individual_area_check` valida plannedAreaHa e actualAreaHa contra o
Field referenciado, em INSERT ou mudança de áreas/escopo. Faz UPDATE sem mudança
de valor em Field.areaHa e lê a capacidade via RETURNING. Essa escrita bloqueia
a linha até o fim da transação e cria nova versão MVCC, sem mudar hectares,
geometryRevision ou updatedAt. É deliberada: somente SELECT FOR UPDATE poderia
deixar uma revisão de capacidade em Repeatable Read com snapshot antigo sem
enxergar um Planting recém-confirmado. A mudança de versão força conflito de
serialização nesses casos. Requer permissão UPDATE na coluna para o futuro
escritor e produz escrita adicional; não é um contador de ocupação.
[Referência PostgreSQL: isolamento](https://www.postgresql.org/docs/18/transaction-iso.html).

`Field_individual_capacity_check` rejeita redução que deixe qualquer área
individual planejada/real já registrada acima da nova capacidade. Não reescreve
o histórico. Validação inclui plantios encerrados; uma futura revisão territorial
com fatos históricos exigirá o fluxo de versões/correções, não truncamento de áreas.
Quatro testes concorrentes confirmam ambas as ordens (plantar/reduzir primeiro)
em Read Committed e Repeatable Read: observam o bloqueio via pg_blocking_pids,
confirmam o primeiro escritor e exigem rejeição do conflitante. Transações futuras
devem tratar serialização/deadlocks repetindo a operação inteira, com idempotência.

**A soma de ocupações simultâneas NÃO está implementada.** Um teste explicita que
60+50 ha em Field de 100 ha ainda é estruturalmente gravável, embora proibido em
execução por D4. Não liberar o fluxo de execução antes do enforcement agregado.
O protocolo futuro aprovado deve bloquear Field, reler todos os intervalos reais
sobrepostos e calcular a soma nos pontos de início/fim de [actualStart,actualEnd).
Fim real ausente continua ocupando; previsão vencida não libera terra; históricos
finalizados/cancelados com execução continuam contando nos seus intervalos.
PLANNED não reserva rigidamente. Alterar datas, áreas, encerramento ou capacidade
deve usar o mesmo protocolo; se necessário, bloquear Farm antes de Field, em ordem
estável. Não basta somar IN_PROGRESS nem proibir toda sobreposição.

Também ficam para fluxo transacional: soma de talhões ativos <= total da Farm,
interseção entre talhões, revisão territorial/auditoria e proteção semântica de
reparenting. A inativação preserva linhas, mas não é autorização para apagar
execuções. Não há subareaGeometry de Planting, consórcio ou mapa frontend.

### Seed e testes

`prisma/crops.mjs` acrescenta oito culturas globais: SOYBEAN, CORN, COTTON, BEAN,
WHEAT, COFFEE, SORGHUM e SUGARCANE. INSERT ON CONFLICT usa o índice parcial:
reexecução/concorrência não duplica culturas; nomes conhecidos são reconciliados
sem reativar culturas deliberadamente inativadas. Não cria culturas privadas.
`prisma/seed.mjs` executa seedPermissions e seedGlobalCrops na mesma transação,
preservando o comportamento do catálogo Permission. Scripts existentes bastam.

`agriculture.integration.test.mjs` exercita FKs, unicidades, checks, geometria,
revisões, seeds, capacidade individual e seus conflitos concorrentes. Cenários
comuns fazem rollback. Os quatro concorrentes precisam de fixtures confirmadas;
criam IDs exclusivos e removem somente esses IDs em finally, sem truncate/reset.
Uma interrupção forçada do processo pode deixar fixtures identificadas como teste;
execute somente no banco local. Os testes anteriores permanecem inalterados.

Nenhuma dependência, entidade extra, autenticação, endpoint ou alteração frontend.
Nenhuma nova decisão de produto foi necessária; permanecem as limitações explícitas
de enforcement e fluxos futuros descritas acima.

## Evolu��o Sprint 2, Tarefa 04 � capacidade temporal implementada

A migration `20261016120000_planting_temporal_capacity` substitui a limita��o
agregada descrita na se��o hist�rica da Tarefa 03. N�o altera schema.prisma,
FKs, modelos, PostGIS ou migrations aplicadas.

- Planting_lifecycle_check imp�e PLANNED sem dados reais; IN_PROGRESS com
  �rea/in�cio e sem fim; FINISHED com os tr�s; CANCELLED sem execu��o ou completo.
- Planting_real_interval_check exige actualEndDate > actualStartDate; fim exclusivo,
  primeira data livre, sem acr�scimo autom�tico de um dia.
- planting_occupation_peak soma eventos de in�cio/fim por data e obt�m o m�ximo
  acumulado em NUMERIC exato por organiza��o/fazenda/Field. Fim nulo � aberto.
- Planting_temporal_capacity_check e Field_temporal_capacity_check rejeitam
  ocupa��o excedente e redu��o incompat�vel com o pico, inclusive hist�rico.
- check_planting_individual_area mant�m a escrita de vers�o MVCC de Field e a
  estende a datas/status; impede limpar dados reais de uma execu��o existente.
- Checks e preflight sob locks da migration recusam dados incompat�veis sem
  corrigir, apagar ou normalizar fatos. BEFORE bloqueia/versiona; AFTER valida
  resultado do comando sem duplicar OLD/NEW, inclusive comandos multilinha.

FINISHED e CANCELLED executados contam no intervalo hist�rico. PLANNED n�o
reserva agregado, mas sua �rea individual ainda deve caber no Field. Alterar
actualAreaHa reinterpretaria todo o intervalo: corre��es operacionais auditadas,
ocupa��o segmentada e execu��o parcial ficam fora da API de planejamento.
N�o h� garantia de imutabilidade hist�rica completa contra usu�rio privilegiado.

O banco garante capacidade para escritores SQL comuns; API continua respons�vel
por autoriza��o, estados dos pais e escopo. API bloqueia Farm ? Field ? Planting
quando existente, rel� autoriza��o e bloqueia Season/Crop durante valida��o.
Repeatable Read obsoleto aborta por serializa��o gra�as � nova vers�o do Field;
Read Committed valida o estado confirmado. Deadlocks podem ocorrer entre escritores
com ordens diferentes; repetir exige transa��o inteira e idempot�ncia adequada.

Contrato completo e limites: [plantings-api.md](plantings-api.md). Enforcement
temporal n�o prova aus�ncia de sobreposi��o geom�trica nem implementa cons�rcio.
