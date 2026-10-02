# AgroTrack — modelo conceitual do domínio

**Sprint 1 — Tarefa 01 | 02/10/2026 | Modelo conceitual com decisões D1–D8 aprovadas pelo usuário; não implementado.**

## 1. Visão geral e limites

Organization representa o cliente/operação do AgroTrack; Farm representa uma de suas fazendas. User é uma identidade global e pode participar de várias organizações, sempre por OrganizationMembership. Autorizações de uma organização nunca se propagam para outra.

Esta proposta parte do monorepo existente, NestJS, Prisma **7.10.0**, PostgreSQL **18** e PostGIS **3.6**. O schema atual não possui modelos de domínio. Este documento e o [diagrama ER conceitual](./domain-model.mmd) não criam modelos Prisma, migrations, tabelas, endpoints ou autenticação. Regras abaixo são contratos conceituais para uma implementação posterior; as decisões D1–D8 estão aprovadas e registradas na seção final.

O diagrama mostra o núcleo e algumas relações auxiliares importantes. Não é uma especificação de todas as colunas nem substitui as FKs compostas, regras condicionais e validações descritas aqui. Entidades de extensão futura são identificadas no texto; sua presença conceitual não exige implementar todo o catálogo de uma vez.

Convenções: `?` indica atributo/relação opcional; `0..N` inclui nenhum registro; datas operacionais sem hora usam data civil; instantes de eventos usam UTC com timezone (`timestamptz`). A fazenda terá timezone IANA para apresentação e calendários locais. `createdAt`/`updatedAt` são comuns a cadastros mutáveis; fatos imutáveis usam data de ocorrência e data de registro separadas. Quantidades e áreas usam Decimal, conforme seção 10.

## 2. Fronteiras de domínio e aggregates sugeridos

| Fronteira | Raízes e responsabilidade | Limite de consistência |
| --- | --- | --- |
| Identidade e acesso | User; Organization; OrganizationMembership; Role; Invitation | Identidade não depende do tenant. Vinculação, papel e acesso a fazendas dependem dele. Alterações de acesso são transacionais e auditadas. |
| Estrutura territorial | Farm; Field | Cadastro, capacidade e limites espaciais. Farm não carrega todo o histórico agrícola como um aggregate em memória. |
| Planejamento agronômico | Season; Planting; catálogo Crop | Planting materializa cultura, área e intervalo de ocupação do talhão. A capacidade compartilhada é protegida pelo bloqueio de Field. |
| Execução operacional | Activity, com ActivityInput e ActivityMachine | Plano e execução distintos. Publicar execução que consome insumos coordena atividade e estoque na mesma transação. |
| Materiais | Product; InventoryItem; InventoryTransfer com suas linhas | InventoryItem é a conta por fazenda/produto; InventoryMovement é o fato contábil imutável. Transferência coordena contas distintas. |
| Ativos e produção | Machine; Harvest | Utilização/manutenção de ativos e fatos de colheita. Não confundir registrar uma atividade com registrar produção. |
| Supervisão | Alert; AuditLog | Alert é informação operacional derivável. AuditLog é evidência histórica protegida, não o ledger nem fonte do saldo. |

Recomenda-se um monólito modular NestJS, com módulos alinhados a essas fronteiras e transações compartilhadas quando necessárias. Não há justificativa nesta etapa para microsserviços, event sourcing completo, motor genérico de workflow ou hierarquia territorial arbitrária. Limite de módulo não impede uma transação entre módulos no mesmo banco.

## 3. Entidades, responsabilidades e atributos conceituais

### 3.1 Identidade, organização e acesso

| Entidade | Responsabilidade | Principais atributos propostos |
| --- | --- | --- |
| User | Identidade global da pessoa, sem `organizationId` | UUID, nome de exibição, email normalizado único, status ativo/bloqueado, datas. Credenciais/provedores serão projetados na tarefa de autenticação. |
| Organization | Operação contratante e fronteira de isolamento | UUID, nome, código de referência, status em provisionamento/ativa/suspensa/encerrada, datas. Não possui `ownerUserId` como única fonte de propriedade. |
| OrganizationMembership | Participação de User em Organization | UUID, organizationId, userId, roleId, status ativo/suspenso/revogado, joinedAt, revokedAt?. Um vínculo durável por organização/usuário. |
| FarmMembership | Escopo explícito de fazendas de um membro | UUID, organizationId, organizationMembershipId, farmId, status ativo/revogado, datas. Não referencia apenas User. |
| Role | Conjunto nomeado de capacidades de uma organização | UUID, organizationId, nome, systemCode? (`OWNER`, `MANAGER`, `AGRONOMIST`, `WORKER`), status. Código reservado não pode ser atribuído por clientes arbitrários. |
| Permission | Catálogo global de ações conhecidas pela aplicação | Código estável único, descrição, escopo organization/farm, status. Ex.: `activity.execute_assigned`, `inventory.adjust`. Não é uma expressão SQL fornecida pelo usuário. |
| RolePermission | Concessão explícita de uma permissão a um papel | organizationId, roleId, permissionCode; combinação única. Não concede escopo territorial. |
| Invitation | Oferta de participação antes de existir membership ou User | UUID, organizationId, email normalizado de destino, roleId, inviterMembershipId? para provisionamento, tokenDigest, expiresAt, acceptedAt?, revokedAt?, acceptedMembershipId?. Nunca o token em claro. |
| InvitationFarm | Fazendas oferecidas no convite | organizationId, invitationId, farmId; par invitation/farm único. Não é uma lista JSON sem integridade referencial. |

Fluxo aprovado (D1): operador autorizado da plataforma provisiona Organization e indica o primeiro OWNER por procedimento administrativo separado e auditado; a ativação exige ao menos um OWNER ativo. A organização pode possuir múltiplos OWNER ativos, todos com visão completa da organização. No fluxo normal, somente OWNER devidamente autorizado pode promover/convidar outro OWNER; uma organização ativa nunca pode perder seu último OWNER ativo. Não usar `ownerUserId` em Organization como fonte única de propriedade. Um usuário existente pode aceitar convite de outra organização sem duplicar sua identidade. O vínculo é criado/reativado apenas após aceitar; não criar User fictício para email pendente.

O operador da plataforma não é um OWNER universal. Provisionamento usa um caminho administrativo separado e auditado, com privilégio mínimo. Não existe cadastro público irrestrito. Convites usam segredo aleatório de alta entropia, digest persistido, validade limitada, uso único, revogação e rate limit. Reenvio invalida o anterior. A aceitação deverá verificar a identidade/email correspondente, revalidar papel/fazendas e consumir o convite em transação; encaminhar um link não autoriza associar qualquer conta. E-mail automático fica para depois; logs e auditoria não guardam o link secreto.

### 3.2 Território e produção agrícola

| Entidade | Responsabilidade | Principais atributos propostos |
| --- | --- | --- |
| Farm | Propriedade operacional de uma organização | UUID, organizationId, código, nome, localização textual, município, estado, país, timezone, totalAreaHa, productiveAreaHa, descrição?, status ativa/inativa, datas. Ponto/limite geográfico são extensões compatíveis, não substitutos do endereço. |
| Field | Talhão estável, independente da cultura atual | UUID, organizationId, farmId, código, nome, areaHa, tipo de solo?, descrição?, observações?, status ativo/inativo, geometry?, geometryRevision, origem/qualidade da área. |
| Crop | Catálogo agronômico, não item de estoque | UUID, scope GLOBAL/ORGANIZATION, organizationId?, código, nome, status, unidade de colheita sugerida?. Soja/milho etc. podem ser globais; customizadas pertencem à organização. |
| Season | Ciclo de planejamento de uma fazenda | UUID, organizationId, farmId, código/nome (ex.: 2026/2027), startDate, expectedEndDate, actualEndDate?, status PLANNED/IN_PROGRESS/FINISHED/CANCELLED. |
| Planting | Cultivo de uma cultura numa porção do talhão durante um intervalo | UUID, organizationId, farmId, seasonId, fieldId, cropId, variedade textual?, plannedAreaHa, actualAreaHa?, plannedStartDate, expectedEndDate?, actualStartDate?, actualEndDate?, quantidade/unidade de sementes prevista?, espaçamento em metros?, população de plantas/ha?, observações?, status PLANNED/IN_PROGRESS/FINISHED/CANCELLED, subareaGeometry? futura. |

Farm: `0 <= productiveAreaHa <= totalAreaHa`, área total positiva. Field ativo tem área positiva; somas de talhões ativos não podem ultrapassar a área total da fazenda sem revisão cadastral. Área produtiva da Farm é um conceito administrativo que pode excluir estradas/reservas: não igualar automaticamente sua soma à área geométrica de talhões. Mudanças de área não podem invalidar ocupações existentes.

Season pertence a uma única Farm; datas previstas são expectativas, não comprovantes de execução. Safras podem sobrepor-se no calendário (safrinha, perenes); não criar unicidade ou exclusão por intervalo da fazenda. Encerrar uma safra exige tratar plantios ainda ativos; reabertura/correção precisa de autorização e auditoria, sem reescrever fatos já publicados.

Planting não representa uma operação de máquina: a atividade do tipo plantio registra a execução. Quantidade de sementes **prevista** pode compor o planejamento; consumo efetivo vem de ActivityInput/InventoryMovement. Não manter dois saldos de sementes consumidas. Variedade começa como texto; catálogo de cultivares pode ser introduzido quando houver necessidade real.

### 3.3 Execução operacional

| Entidade | Responsabilidade | Principais atributos propostos |
| --- | --- | --- |
| Activity | Trabalho planejado e sua execução | UUID, organizationId, farmId, fieldId?, plantingId?, tipo, descrição, responsibleMembershipId?, plannedStartAt, plannedEndAt?, actualStartAt?, actualEndAt?, status DRAFT/PLANNED/IN_PROGRESS/COMPLETED/CANCELLED, observações?, versão de concorrência. |
| ActivityInput | Linha de insumo planejado e vínculo com consumos efetivos | UUID, organizationId, farmId, activityId, lineNumber, productId, plannedQuantity, unitId, dose prevista? com unidade explícita. Quantidade efetiva é derivada das movimentações vinculadas. |
| ActivityMachine | Alocação de máquina à atividade | UUID, organizationId, farmId, activityId, machineId, horas previstas?, operadorMembershipId?, leituras inicial/final de horímetro?, início/fim reais?. Par activity/machine único no MVP. |
| ActivityParticipant — extensão | Participantes além do responsável | organizationId, farmId, activityId, organizationMembershipId, papel na execução. O responsável principal continua explícito. |

Tipos iniciais: PLANTING, SPRAYING, FERTILIZATION, IRRIGATION, HARVEST, SOIL_PREPARATION, MAINTENANCE, OTHER. São códigos fechados no MVP, sem catálogo customizável de workflows.

Uma atividade pode existir só na fazenda (manutenção), num talhão sem plantio (preparo) ou num plantio. Se houver plantingId, fieldId é obrigatório e deve ser o do Planting; não permitir atividade que aponta para plantio de outro talhão ou safra de outra fazenda. No MVP, no máximo um talhão/plantio por atividade; executar em vários talhões exige atividades separadas. O histórico de consumo fica rastreável por operação.

Planejado não significa realizado: preparar ActivityInput não baixa estoque. Iniciar registra instante real; finalizar registra execução e confirma consumos, máquinas e produção aplicáveis. Worker só pode executar o trabalho atribuído e autorizado. Responsável/operador devem ser memberships ativos com acesso à fazenda no momento da atribuição/execução; revogá-los depois não elimina a referência histórica.

Reenvios do mobile precisam de chave de idempotência e controle de versão, mesmo sem funcionamento offline no MVP. Finalização repetida não pode gerar novo consumo. Atividade concluída não volta silenciosamente para planejada. Corrigir/cancelar execução confirmada exige fluxo auditado e compensações físicas coerentes; cancelar não devolve automaticamente insumo já aplicado.

### 3.4 Materiais e estoque

| Entidade | Responsabilidade | Principais atributos propostos |
| --- | --- | --- |
| Product | Item material cadastrado na organização | UUID, organizationId, SKU/código, nome, categoria (semente, fertilizante, defensivo, combustível etc.), baseUnitId, descrição?, status. Marca/apresentação podem distinguir produtos. |
| InventoryItem | Conta de estoque por Farm e Product | UUID, organizationId, farmId, productId, minimumQuantityBase?, status. Único por organização/fazenda/produto. Não tem saldo autoritativo editável. |
| InventoryMovement | Lançamento efetivado e imutável no ledger | UUID, organizationId, farmId, inventoryItemId, lotId?, tipo, deltaBase assinado, enteredQuantity, unitId, conversionFactorSnapshot, occurredAt, recordedAt, sequência de registro, actorMembershipId?, activityInputId?, transferLineId?, reversalOfId?, idempotencyKey, motivo/documento?. |
| InventoryTransfer | Operação entre fazendas da mesma organização | UUID, organizationId, originFarmId, destinationFarmId, estado DRAFT/POSTED/CANCELLED, responsável, datas, chave de idempotência. |
| InventoryTransferLine | Quantidade de um produto/lote transferida | UUID, organizationId, transferId, lineNumber, productId, sourceInventoryItemId, destinationInventoryItemId, lotId?, quantityBase. Uma linha efetivada gera exatamente dois lançamentos opostos. |
| InventoryLot — extensão preparada | Identidade rastreável de um lote do produto | UUID, organizationId, productId, código interno, código do fabricante?, fabricação?, validade?, supplierId?. Não pertence exclusivamente a uma fazenda; pode estar em várias após transferências. |
| Supplier — extensão | Fornecedor privado da organização | UUID, organizationId, código, nome, contatos mínimos necessários, status. Referenciado em lote/entrada quando essa etapa for implementada. |

Um Product pode ter zero contas de estoque ou várias, em fazendas distintas. InventoryItem existe mesmo com saldo zero e oferece uma linha estável para bloqueio transacional. Lotes não duplicam a definição do produto; quantidade por lote é uma dimensão do ledger da mesma conta. `minimumQuantityBase` é por fazenda/produto, não repetida por lote.

Crop e Product não são intercambiáveis: “soja” é cultura; “semente de soja BRS 284, apresentação X” é produto. Não exigir vínculo Crop–Product para todo insumo. Colheita não vira entrada em um estoque de grãos automaticamente nesta fase; tal integração futura deverá escolher um Product e contabilizar a entrada explicitamente, sem duplicar produção.

### 3.5 Unidades e ativos

| Entidade | Responsabilidade | Principais atributos propostos |
| --- | --- | --- |
| Unit | Catálogo global de unidades e dimensões | Código estável (kg, g, L, mL, un, sc, t, ha, h, m), nome, dimensão, fator para unidade canônica quando universal, status. |
| ProductUnitConversion | Conversão específica de apresentação de produto | UUID, organizationId, productId, fromUnitId, factorToBase, versão/vigência, status. Necessária para saca/embalagem sem fator universal; não cadastrar conversões arbitrárias entre massa e volume. |
| Machine | Ativo de uma fazenda | UUID, organizationId, farmId, código/identificação, nome, tipo, marca?, modelo?, ano?, status ACTIVE/MAINTENANCE/INACTIVE, leitura inicial de horímetro?, referência da última leitura válida. |
| MachineUsage — extensão | Sessões de utilização mais detalhadas | organizationId, farmId, machineId, activityMachineId?, operadorMembershipId, início/fim, horímetros. Substitui o limite de uma sessão de ActivityMachine quando necessário. |
| MachineMaintenance — extensão | Manutenção e seus custos/limites futuros | organizationId, farmId, machineId, activityId?, data, tipo, horas de referência, próxima data/horas, custo/moeda, observações. |

### 3.6 Colheita, alertas e auditoria

| Entidade | Responsabilidade | Principais atributos propostos |
| --- | --- | --- |
| Harvest | Fato de produção de um Planting | UUID, organizationId, farmId, plantingId, activityId?, data, harvestedAreaHa, newlyHarvestedAreaHa, quantidade informada, unitId, fator/peso da saca aplicado?, netWeightKg? quando conversível, perdas com unidade?, estado DRAFT/CONFIRMED, reversesHarvestId?, observações?. |
| Alert | Condição operacional a acompanhar | UUID, organizationId, farmId?, categoria, severity INFO/WARNING/CRITICAL, título/mensagem segura, sourceType/sourceId?, deduplicationKey, estado OPEN/RESOLVED, firstDetectedAt, lastDetectedAt, resolvedAt?. |
| AuditLog | Evidência de uma ação relevante | UUID, organizationId, farmId?, actorType USER/PLATFORM/SYSTEM, actorMembershipId?, actorReference?, ação, entityType, entityId, timestamp, correlationId?, alterações/metadados permitidos, versão do formato. |
| AlertReceipt — extensão | Leitura individual de um alerta | organizationId, alertId, organizationMembershipId, readAt?. Ler não resolve a condição para toda a equipe. |

No caso USER, AuditLog exige actorMembershipId do mesmo tenant; User é obtido pelo membership preservado. Para SYSTEM/PLATFORM, ator é uma referência de identidade de serviço/operador controlada pelo servidor, não uma pessoa fictícia. Assim, o mesmo usuário não recebe exposição a outros tenants por aparecer em auditorias.

## 4. Relacionamentos e cardinalidades

| Relação | Cardinalidade e condição |
| --- | --- |
| User → OrganizationMembership ← Organization | User `1 → 0..N` vínculos; Organization `1 → 0..N` vínculos. Organização ativa exige pelo menos um OWNER ativo. |
| Organization → Role → OrganizationMembership | Organização `1 → 0..N` papéis; cada membership tem exatamente um papel dessa organização no MVP. |
| Role ↔ Permission | N:M por RolePermission; papel vazio não concede ações. OWNER é papel de sistema protegido. |
| OrganizationMembership ↔ Farm | N:M por FarmMembership, sempre dentro da mesma organização. OWNER não precisa de vínculos redundantes com todas as fazendas. |
| Organization → Invitation → InvitationFarm ← Farm | Organização `1 → 0..N` convites; convite `1 → 0..N` escopos. Aceitação associa `0..1` membership; um membership pode ter vários convites históricos. |
| Organization → Farm → Field | Organização `1 → 0..N` fazendas; fazenda `1 → 0..N` talhões. Cada fazenda/talhão tem um único pai. |
| Organization → Crop | `0..1` organização por cultura: nenhuma para global, exatamente uma para customizada. Não é permissão para tenant nulo em tabelas operacionais. |
| Farm → Season → Planting ← Field; Crop → Planting | Cada plantio tem exatamente uma safra, um talhão e uma cultura. Safra, talhão e plantio têm a mesma Farm. Cada pai pode ter `0..N` plantios. |
| Farm → Activity; Field/Planting → Activity | Cada atividade tem uma fazenda; talhão e plantio são `0..1` por atividade, com a dependência condicional descrita acima. |
| Activity → ActivityInput / ActivityMachine | `1 → 0..N` linhas e alocações. Cada linha de insumo referencia um Product; cada alocação, uma Machine da mesma fazenda. |
| Organization → Product; Farm + Product → InventoryItem | Cada conta tem uma fazenda e um produto; combinação é única. Cada conta possui `0..N` movimentos. |
| ActivityInput → InventoryMovement | Linha planejada pode ter zero movimentos; uma execução pode gerar vários lançamentos por lote, retorno ou estorno. Cada movimento tem no máximo uma linha de insumo de origem. |
| InventoryTransfer → InventoryTransferLine → InventoryMovement | Transferência publicada tem `1..N` linhas; linha tem zero movimentos em rascunho ou exatamente dois ao publicar. “Dois” é regra transacional, não cardinalidade expressável pelo ER. |
| Product → InventoryLot → InventoryMovement | Produto `1 → 0..N` lotes; movimento tem `0..1` lote do mesmo produto/organização. |
| Farm → Machine → ActivityMachine | Cada máquina pertence a uma fazenda; pode participar de `0..N` atividades através de alocações. |
| Planting → Harvest; Activity → Harvest | Plantio `1 → 0..N` colheitas; colheita pode ter `0..1` atividade correspondente, do mesmo plantio. |
| Organization → Alert / AuditLog | Cada registro pertence a uma organização; farmId opcional apenas para assuntos realmente organizacionais. Não é uma forma de contornar escopo de fazenda. |

## 5. Multi-tenancy, integridade referencial e prevenção de IDOR

### 5.1 Estratégia recomendada

Recomenda-se banco/schema compartilhado e `organizationId` obrigatório nos dados privados, com autorização no servidor e Row-Level Security como defesa adicional antes de servir múltiplos clientes reais. User, Permission e Unit são globais; Crop é a única exceção de catálogo misto aqui proposta. Role, Product e todos os dados operacionais são privados da organização.

Nas entidades de fazenda, carregar também `farmId`, inclusive em fatos históricos/linhas de ledger. Essa redundância é deliberada para escopo e índices, **sempre amarrada por FKs compostas**; não confiar em copies feitas pelo frontend. Organization/farm de um fato publicado não podem ser trocadas por uma atualização de cadastro.

Padrões de integridade para a futura modelagem física:

- Pais operacionais oferecem chave candidata `(organizationId, farmId, id)`; Farm, `(organizationId, id)`; pais de organização, `(organizationId, id)`.
- FarmMembership referencia Farm por `(organizationId, farmId)` e OrganizationMembership por `(organizationId, organizationMembershipId)`.
- OrganizationMembership referencia Role por `(organizationId, roleId)`; RolePermission e Invitation seguem o mesmo padrão.
- Planting referencia Field e Season com organização **e fazenda**. ActivityInput e ActivityMachine referenciam Activity com o escopo completo; produto pertence à organização e máquina à fazenda.
- Activity com Planting usa vínculo composto que inclui também fieldId; exigir fieldId não nulo nesse caso. FKs opcionais parcialmente nulas não podem deixar passar combinações inválidas: usar checks condicionais/`MATCH FULL` onde aplicável, em vez de supor que qualquer FK composta basta.
- Movement referencia InventoryItem pelo escopo completo. Para consumo, a linha ActivityInput precisa do mesmo produto, organização e fazenda; incluir productId em chaves candidatas se necessário. FK só de movement → activityInput por id não prova essa compatibilidade.
- TransferLine deve referenciar contas da origem/destino declarados no cabeçalho, ambas com seu produto. O lote, quando presente, pertence ao mesmo produto e organização. Esses vínculos exigem chaves compostas auxiliares e/ou constraint triggers, além das FKs simples do ER.
- Harvest com activityId precisa corresponder ao mesmo plantingId; responsáveis e atores históricos usam memberships do tenant, nunca um userId arbitrário vindo do cliente.

### 5.2 Catálogo global de culturas: exceção explícita

Crop global tem `scope=GLOBAL` e organizationId nulo; customizada tem `scope=ORGANIZATION` e organização não nula. Check na própria linha garante essa combinação. Escopo/organização da cultura ficam imutáveis depois da criação; desativar preserva referências existentes e apenas impede novos usos.

A FK `Planting.cropId → Crop.id` **não garante** a regra “global OU do mesmo tenant”. Recomenda-se verificá-la na aplicação e, na implementação física, por constraint trigger nos vínculos (e bloqueio de mudança de escopo do catálogo). A alternativa física é separar catálogo global/customizado e usar referências tipadas; não aceitar FKs nulas como solução automática de isolamento. Índices únicos distintos controlam código global e `(organizationId, código)` de culturas próprias; nomes de exibição não precisam ser globalmente únicos.

Somente a plataforma mantém o catálogo global. OWNER pode cadastrar culturas próprias, mas não alterar uma cultura global usada por outros clientes. Catálogos globais não contêm observações privadas de uma organização. Listagens retornam globais mais customizadas do tenant ativo, nunca todas as culturas customizadas.

### 5.3 Autorização em cada operação

O contexto de tenant vem da identidade autenticada e do membership validado pelo servidor; escolher organização no frontend apenas solicita contexto. Toda leitura, escrita, contagem, busca, mapa, exportação, job e consulta raw valida organização, permissão e fazenda. Não buscar por id global e presumir acesso depois. Consultas de detalhe devem ser restringidas ao conjunto autorizado desde o início; respostas não revelam se um identificador pertence a outro cliente.

Validar cada ID relacionado recebido, não só o recurso principal: farmId, cropId customizado, seasonId, fieldId, responsável, máquina, produto, lote e destino de transferência. Restringir campos atualizáveis para evitar mass assignment de organização, papel ou status protegido. Chaves de cache e idempotência incluem tenant e escopo aplicável. Suspensão/revogação invalida decisões de autorização em cache; não confiar por tempo indeterminado no papel embutido numa sessão. UUID não substitui essas verificações. A orientação é negar por padrão e conferir permissões em cada requisição. [Referência: OWASP Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html).

### 5.4 Defesa no PostgreSQL

RLS deve negar por padrão sem contexto e limitar linhas privadas pelo tenant; estender políticas ao conjunto de fazendas autorizado nas tabelas operacionais. Catálogos compartilhados têm políticas próprias. A conexão da aplicação não deve ser superuser, ter `BYPASSRLS` nem ser dona das tabelas; considerar `FORCE ROW LEVEL SECURITY`. O usuário administrativo do Compose atual é apenas de desenvolvimento, não prova isolamento. [PostgreSQL: RLS](https://www.postgresql.org/docs/18/ddl-rowsecurity.html).

Com o pool Prisma, estabelecer contexto validado **local à transação**, usando parâmetros, na mesma conexão de todas as consultas; nunca um `SET` de sessão que vaze para o próximo usuário. O contexto não é uma credencial escolhida pelo cliente. Jobs também precisam de tenant explícito. Antes de habilitar tráfego multi-tenant, testes devem cobrir leitura, inserção, alteração, exclusão, raw SQL e conexão reutilizada. FKs compostas impedem vínculos cruzados; não impedem leitura indevida, e RLS não substitui autorização de ação.

## 6. RBAC: decisão híbrida e consequências

**Decisão aprovada (D2):** manter a estratégia híbrida Role + Permission + RolePermission. Role e Permission são entidades; códigos dos quatro perfis de sistema e das ações são constantes estáveis da aplicação. No MVP cada organização recebe quatro Role de sistema protegidos e sua matriz padrão em RolePermission. Cada OrganizationMembership tem um papel uniforme nas fazendas às quais tem acesso. FarmMembership define exclusivamente o escopo territorial; não contém uma cópia do papel.

Um enum isolado de papéis obrigaria mudanças de schema/código para toda personalização. Um mecanismo genérico de políticas, negações, heranças e exceções por usuário seria excessivo agora. O híbrido mantém matriz auditável, FK de membership, papéis customizados futuros por organização e um catálogo de capacidades que o servidor conhece. Novas permissões exigem código que as aplique; cadastrar uma linha nunca cria capacidade executável por si só.

Matriz de permissões aprovada em D2:

| Capacidade | OWNER | MANAGER | AGRONOMIST | WORKER |
| --- | --- | --- | --- | --- |
| Organização, membros, convites e papéis | Completo | Não | Não | Não |
| Criar/inativar fazendas; atribuir acessos | Sim | Não | Não | Não |
| Ler operações e mapas | Todas as fazendas da organização | Fazendas atribuídas | Fazendas atribuídas | Apenas informação necessária ao trabalho nas atribuídas |
| Manter talhões, safras e plantios | Sim | Sim, atribuídas | Sim, atribuídas, escopo técnico | Não |
| Planejar/atribuir atividades | Sim | Sim, atribuídas | Atividades técnicas, atribuídas | Não |
| Iniciar/registrar/finalizar atividades | Sim | Sim, atribuídas | Sim, técnicas e atribuídas | Somente atividades atribuídas à pessoa |
| Lançar compra, ajuste e transferência | Sim | Sim, atribuídas; transferência exige ambas | Não | Não |
| Consumir insumo pela execução | Sim | Sim | Nas execuções autorizadas | Nas execuções atribuídas; sem edição direta do ledger |
| Registrar produção | Sim | Sim | Sim, atribuídas | Pela atividade de colheita atribuída |
| Estornar fatos; consultar custos/auditoria | Sim | Somente fazendas atribuídas | Sem ajustes financeiros; evidências técnicas autorizadas | Sem visão administrativa/financeira |

OWNER alcança todas as fazendas da **sua organização** pela posição, inclusive leitura histórica de inativas; não é OWNER de todas as organizações do User. Acesso consolidado soma somente escopos autorizados. Demais perfis exigem FarmMembership ativo, inclusive MANAGER. Um membro pode acessar várias fazendas.

No MVP o papel é uniforme nas fazendas atribuídas: “gerente na A e funcionário na B” não é expressável ainda. Se necessário depois, introduzir atribuição de papel por FarmMembership com regra de precedência explícita, sem somar permissões inadvertidamente. Não implementar essa complexidade agora.

Personalização futura, fora do primeiro MVP conforme D2: OWNER cria papéis privados com subconjuntos de Permission aprovadas para delegação e os atribui aos membros. Papéis de sistema, especialmente OWNER, ficam protegidos; não editar um papel compartilhado globalmente. Não há herança implícita (“gerente maior que agrônomo”), negações conflitantes nem overrides por usuário no MVP. Permissão nova nunca amplia automaticamente o conjunto de fazendas. Nunca revogar/rebaixar o último OWNER ativo; bloquear a organização durante alterações concorrentes de propriedade.

## 7. Estratégia geoespacial

### 7.1 Representação, referência espacial e validação

Estratégia aprovada em D3: **`geometry(MultiPolygon, 4326)`** para limites de Field e, futuramente, subáreas de Planting. MultiPolygon aceita um polígono único e parcelas descontínuas sem trocar o tipo depois; não autoriza coordenadas soltas ou qualquer GeometryCollection. Normalizar entradas Polygon para MultiPolygon. SRID **EPSG:4326 / WGS 84**, em duas dimensões, facilita interoperar com mapas/GeoJSON; ordem de coordenadas é longitude, latitude. Importações com outra referência exigem transformação, não apenas alterar o rótulo do SRID. [PostGIS: tipos e referência espacial](https://postgis.net/docs/using_postgis_dbmanagement.html).

Conforme D3 aprovada, Field pode existir e operar sem geometria no MVP; nesse caso, o sistema deverá apresentar estado equivalente a “Talhão ainda não mapeado”. Geometria presente deve ter SRID/tipo corretos, ser não vazia, válida e estar dentro dos limites de coordenadas aceitos. Rejeitar autointerseções e limitar quantidade de vértices/tamanho de upload. Não corrigir silenciosamente com `ST_MakeValid`, que pode alterar a interpretação territorial; apresentar a mudança para revisão. [PostGIS: ST_IsValid](https://postgis.net/docs/ST_IsValid.html).

Polígonos de plantio devem estar cobertos pelo talhão (`ST_Covers` inclui a borda). Talhões ativos não devem se sobrepor fisicamente na mesma fazenda, exceto contatos de borda; subáreas de plantios simultâneos seguem a política da seção 8. Validade topológica isolada não garante contenção nem ausência de sobreposição. [PostGIS: ST_Covers](https://postgis.net/docs/ST_Covers.html).

### 7.2 Áreas e índices

**Não calcular hectares com `ST_Area(geometry4326)` diretamente:** suas unidades são angulares. Para área de referência, usar `ST_Area(geometry::geography) / 10000` (m² → ha), ou uma projeção métrica adequada à região. Não escolher um único fuso UTM para propriedades em todo o país. Converter/quantizar o resultado ao Decimal de domínio; representação geométrica e cálculo espacial usam aproximações numéricas e não ganham precisão por um cast. [PostGIS: ST_Area](https://postgis.net/docs/ST_Area.html).

Conforme D3 aprovada, a área declarada/validada é inicialmente a referência oficial de capacidade. Quando houver geometria, calcular também a área geográfica, mantendo as duas medidas distintas e registrando origem, revisão e eventual divergência. Não substituir automaticamente a área declarada pela calculada. Diferença superior a **2%**, em relação à área declarada, exige revisão/sinalização: `abs(areaCalculadaHa - areaDeclaradaHa) / areaDeclaradaHa * 100 > 2`, com área declarada positiva. Exatamente 2% não ultrapassa esse limite. Esse limiar de divergência não concede margem para exceder a capacidade de ocupação. Edições não recalculam hectares históricos de plantios/colheitas confirmados.

Índice GiST sobre geometry suporta seleção espacial por viewport/proximidade/interseção; B-tree de `(organizationId, farmId, status)` complementa o filtro. GiST não é controle de acesso. Não usar apenas interseção de bounding boxes como prova de sobreposição real. Predicados espaciais exatos confirmam candidatos; filtros de tenant/fazenda acompanham todas as consultas. GeoJSON é formato de transporte, não segunda fonte de verdade em JSON editável paralelamente à geometry. [PostGIS: armazenamento e índices espaciais](https://postgis.net/docs/using_postgis_dbmanagement.html).

### 7.3 Interoperabilidade com Prisma 7

Para a versão 7.10.0 instalada, planejar um campo conceitualmente representado por `Unsupported("geometry(MultiPolygon,4326)")?`, não assumir CRUD tipado de PostGIS pelo Client. A documentação de tipos não suportados informa que esses campos não ficam disponíveis como campos comuns do Client. Coluna, checks, GiST e outros recursos não representáveis exigirão SQL versionado em migrations futuras; extensão também deve existir no banco de shadow/CI, não apenas no volume Docker inicial. **Nada disso é executado nesta tarefa.** [Prisma: recursos não suportados](https://www.prisma.io/docs/orm/prisma-schema/data-model/unsupported-database-features).

Isolar operações espaciais num adaptador/repositório da infraestrutura NestJS, usando `$queryRaw`/`$executeRaw` parametrizados ou TypedSQL quando adequado. Ler como `ST_AsGeoJSON`, criar/validar geometria com funções PostGIS e converter explicitamente tipos não suportados antes de retornar resultados. Nomes de coluna/ordenação vêm de allowlist interna; não concatenar GeoJSON, IDs ou fragmentos SQL fornecidos pelo usuário. O adaptador recebe o mesmo cliente transacional e escopo da operação comum, preservando atomicidade e RLS. [Prisma: consultas raw e segurança](https://www.prisma.io/docs/orm/prisma-client/using-raw-sql/raw-queries).

## 8. Ocupação do talhão e plantios simultâneos

Field não tem `cropId` representando “cultura atual”. A relação é **Field → vários Planting**, cada qual com Crop, Season, área e intervalo próprios. Conforme D4 aprovada, talhão de 100 ha pode conter 60 ha de soja e 40 ha de milho simultaneamente, em subdivisões exclusivas; 60 ha de soja mais 50 ha de milho não são permitidos durante a execução.

Adotar ocupação efetiva em intervalos semiabertos `[actualStart, actualEnd)`. IN_PROGRESS sem fim real continua ocupando área, mesmo se a previsão tiver vencido. Previsão não libera terra. Um cultivo encerrado continua ocupando área nas consultas históricas do seu intervalo. Cancelamento de um cultivo que chegou a ocorrer não apaga sua ocupação passada; encerrá-la exige data real e motivo.

Regra aprovada (D4): **em qualquer instante relevante, a soma de actualAreaHa dos plantios com intervalos coincidentes no Field não ultrapassa sua capacidade**. Não somar todo o histórico, nem somente linhas cujo status hoje é ativo. Não criar `UNIQUE(fieldId, seasonId)` ou exclusão temporal que proíba todos os simultâneos. Plantings apenas planejados não reservam capacidade de forma rígida; conflitos de planejamento poderão gerar aviso. Ao iniciar/confirmar ocupação efetiva ou replanejar uma execução, revalidar a capacidade e impedir excesso.

Operação concorrente proposta: iniciar transação, autorizar, bloquear a linha Field, reler ocupações sobrepostas, avaliar soma nos pontos de início/fim relevantes, validar e gravar Planting + AuditLog. Se dois novos plantios disputam os últimos hectares, apenas o que ainda cabe após adquirir o bloqueio confirma. Alterações de área/data, encerramento, correção retroativa e revisão da capacidade do Field usam o mesmo protocolo. Bloquear Farm e depois Field em ordem estável quando a alteração também impactar a capacidade cadastral da fazenda.

Um CHECK comum não pode impor essa soma de várias linhas; trigger com bloqueio ou protocolo transacional obrigatório é necessário para todos os escritores. Exclusion constraint temporal simples também seria incorreta aqui: coexistência é permitida. [PostgreSQL: limites de CHECK e constraints](https://www.postgresql.org/docs/18/ddl-constraints.html).

Com subáreas geográficas, também validar cobertura, área da união e ausência de interseção de área positiva nos intervalos coincidentes. Soma de hectares dentro da capacidade não prova que dois desenhos não ocupam o mesmo lugar. Revisões de limites guardam versão/snapshot usada por eventos históricos; não se deve mover um plantio histórico ao editar o Field atual.

**Consórcio sobre os mesmos hectares é uma questão distinta de divisão do talhão.** Conforme D4 aprovada, o primeiro MVP permite subdivisões exclusivas e não inclui consórcio real. Para consórcio futuro, uma ocupação compartilhada identificável precisará contar capacidade uma vez, com vários cultivos associados. Não resolver consórcio desabilitando a validação ou permitindo somas arbitrárias.

## 9. Estoque: ledger, atomicidade e compensações

### 9.1 Fonte de verdade

Saldo da conta/lote é `SUM(deltaBase)` de lançamentos efetivados, incluindo entradas, saídas e compensações. Exemplo em litros: `+100 -18 +20 -5 = 97 L`. Planejamentos/rascunhos não entram no ledger. Uma projeção de saldo pode ser criada depois por desempenho, mas deve ser reconstruível e reconciliada contra os fatos; nunca uma coluna que usuários incrementam sem lançamento correspondente.

Tipos: RECEIPT (entrada), CONSUMPTION (consumo), TRANSFER_OUT/TRANSFER_IN, ADJUSTMENT, RETURN e REVERSAL. Sinal e origem devem combinar com o tipo; delta zero é inválido. Quantidade informada é positiva, unidade e fator ficam registrados e determinam o delta canônico com o sinal. Conforme D5 aprovada, ajustes são permitidos somente a OWNER e MANAGER devidamente autorizados e exigem motivo e auditoria. Motivo também é obrigatório para estorno. Estoque inicial é uma entrada identificada, não valor especial fora do ledger.

Publicações são append-only: sem alterar delta, conta, lote ou data de registro depois de efetivar. Correção gera lançamento compensatório vinculado ao original e, se necessário, novo lançamento correto. Estorno integral tem referência única ao original; devoluções parciais podem ser múltiplas, mas a soma não pode exceder a quantidade consumida líquida já compensada. Não permitir estornar duas vezes ou aplicar devolução e estorno integral sem descontar compensações prévias.

Decisão aprovada (D5): estoque negativo é proibido por InventoryItem e, quando aplicável, por lote. Saldo agregado suficiente não autoriza retirar de um lote sem quantidade. Registros antigos sem lote ficam explicitamente no grupo “lote não informado”, não recebem validade inventada. Produtos que vierem a exigir rastreabilidade não permitem novas saídas sem lote válido. Alertas de validade dependem de lote e saldo remanescente, não da mera existência de um lote vencido.

### 9.2 Consumo por Activity

Para confirmar execução: autorizar atividade e produtos; bloquear Activity e InventoryItems afetados em ordem determinística; reler saldos, lotes e estado; validar quantidade/unidades; publicar todos os movimentos, atualizar a execução e escrever AuditLog na **mesma transação**. Chave única de idempotência identifica o comando; mesmo identificador com conteúdo diferente é conflito. Uma restrição adicional por linha/lote/evento evita duplicidade de baixa.

Não reservar estoque só porque existe plano. Reserva poderá ser entidade futura separada de consumo e saldo físico. A quantidade efetiva de ActivityInput é derivada do consumo líquido relacionado; eventual valor materializado é projeção. Vários lotes usados na mesma linha geram vários movimentos, mantendo a origem da atividade.

### 9.3 Transferência entre fazendas

Decisão aprovada (D6): transferência imediata e atômica no MVP. Validar mesma organização, origem diferente de destino, permissão e acesso a **ambas** as fazendas. Criar/localizar contas destino sob unicidade, bloquear todas as contas em ordem estável e validar disponibilidade. Cada linha produz saída na origem e entrada no destino do mesmo produto, lote, quantidade-base e operação. A soma dos deltas da linha é zero; custo/fator histórico, quando houver, acompanha a identidade transferida.

Cabeçalho, linhas, dois lados do ledger, idempotência e auditoria são confirmados juntos. Se uma entrada falhar, a saída também é revertida pelo rollback. Restrição única `(transferLineId, direção)` impede repetir um lado, mas **não prova** a existência dos dois, igualdade de quantidade ou acerto das contas: validação transacional e constraint trigger diferida devem verificar a publicação completa. Rascunhos não têm movimentos; transferência publicada não é editada nem “cancelada” sem operação compensatória pareada.

Conforme D6 aprovada, despacho, trânsito e aceite ficam para evolução futura. Esses fluxos exigirão saldo em trânsito, estados e confirmações próprios; não serão representados por uma transferência publicada com um dos lados ausente. No MVP, saída na origem e entrada no destino sempre são produzidas na mesma transação. Leitores com acesso a só uma fazenda podem ver sua movimentação, mas não dados privados operacionais da outra; o documento completo de transferência exige acesso aos dois lados ou OWNER.

### 9.4 Concorrência e data efetiva

Bloquear uma InventoryItem existente protege inclusive saldo inicialmente zero; somar e depois inserir sem lock permite consumo concorrente acima do saldo. Todos os caminhos (consumo, ajuste, transferência, devolução) seguem o mesmo protocolo. Alternativa é isolamento Serializable com repetição limitada de transações inteiras e idempotência; não basta configurar isolamento sem tratar falhas de serialização. [PostgreSQL: isolamento transacional](https://www.postgresql.org/docs/18/transaction-iso.html).

Conforme D5 aprovada, `occurredAt` representa quando o evento foi informado como ocorrido; `recordedAt` representa quando foi efetivamente registrado/publicado e, junto à sequência interna, define a ordem do saldo publicado. No MVP, lançamentos tardios exigem motivo apropriado e permissão, sem reconstruir retroativamente toda a sequência histórica de saldos. Movimentos publicados permanecem imutáveis; correções usam movimentos compensatórios. Integrações/notificações futuras usam outbox transacional; não enviar e-mail ou chamar serviço externo segurando locks de estoque.

## 10. Unidades, precisão e quantidades

Unit é um catálogo global controlado, não um texto livre. Quantidade sempre informa unidade; a base de Product é imutável após uso, evitando reinterpretar histórico. Unidades compatíveis normalizam-se em kg (massa), L (volume), un (contagem), ha (área) e h (tempo). `1 g = 0,001 kg`, `1 t = 1.000 kg`, `1 mL = 0,001 L`. “Unidade” não vira peso sem definição específica do produto; itens indivisíveis rejeitam frações.

**Saca não tem massa universal.** `sc` representa embalagem cuja massa líquida de referência deve ser declarada no contexto do produto/colheita e registrada como snapshot. Não presumir 60 kg para toda cultura. O catálogo Crop pode sugerir unidade; o planejamento pode sugerir peso por saca; Harvest registra o fator realmente aprovado. Para estoque, ProductUnitConversion relaciona a apresentação à unidade-base. Mudança de embalagem cria nova versão; movimentos antigos mantêm o fator usado.

Conversão massa ↔ volume exige densidade e condições específicas, não regra global; fica fora do MVP. Taxas `kg/ha` e `sc/ha` são razão de unidades, não unidades de estoque. Dose de insumo precisa indicar quantidade e área-base; uma concentração não pode ser somada como quantidade de produto.

Proposta de escalas, a validar contra limites físicos na implementação:

| Grandeza | Representação recomendada | Observação |
| --- | --- | --- |
| Quantidade de estoque, produção e peso | `Numeric(20,6)` | Normalizada por dimensão; validar positivo ou delta assinado conforme o contexto. |
| Área em hectares | `Numeric(18,6)` | Resolução de registro não significa exatidão do levantamento. |
| Fatores de conversão, densidade futura | `Numeric(24,12)` | Fator positivo; snapshot evita recalcular fatos com fator novo. |
| Preço unitário/custo de rateio | `Numeric(20,6)` + moeda | Preservar precisão intermediária. |
| Valor monetário final | `Numeric(20,2)` + moeda | Arredondamento explícito; não somar moedas diferentes. |
| Horímetro/horas | `Numeric(14,3)` | Diferenciar leitura acumulada de duração; não usar float crítico. |

PostgreSQL `numeric` é exato para operações decimais e distinto de float; escala limitada pode arredondar entradas. Na aplicação futura, usar Decimal do Prisma e serializar valores críticos como strings decimais, evitando conversão intermediária para JavaScript Number. Rejeitar NaN/infinidades e precisão excedente na fronteira; quantizar conversões uma vez, documentando o arredondamento (proposta: metade para longe de zero, consistente com Numeric). Transferências usam o mesmo delta-base em ambos os lados, sem duas conversões independentes. [PostgreSQL: tipos numéricos](https://www.postgresql.org/docs/18/datatype-numeric.html).

## 11. Máquinas, manutenção e histórico de uso

Machine pertence a uma Farm e tem identificação única dentro dela. ActivityMachine evita uma coluna única `machineId` em Activity e permite várias máquinas desde o modelo conceitual. Leitura final de horímetro não pode ser menor que a inicial, salvo evento específico de substituição/reset do medidor, com justificativa e histórico próprio. Horas de relógio e diferença do horímetro não são necessariamente iguais.

Último horímetro é uma projeção da leitura inicial e utilizações confirmadas; não aceitar sobrescrita arbitrária que apague uso. Operador é OrganizationMembership autorizado, talhão vem da Activity. Combustível consumido é ActivityInput ligado ao ledger, não baixa paralela. Manutenção pode ser uma Activity do tipo MAINTENANCE, com MachineMaintenance futura para detalhes, custo e próximo limite de data/horas; alerta é derivado desses limites.

No MVP uma máquina não é movida livremente para outra fazenda após ter histórico: isso alteraria o escopo de leituras antigas se elas dependessem só do cadastro atual. Movimentação patrimonial futura exige histórico de alocação, datas e manutenção do farmId nos fatos. GPS/telemetria é extensão separada, com série temporal ligada à máquina e política própria de retenção; não adicionar colunas de última localização a cada atividade agora.

## 12. Colheitas e produtividade sem dupla contagem

Harvest sempre referencia Planting, portanto cultura, safra e talhão são determinados por ele. Não repetir cropId/seasonId editáveis em Harvest. Se uma colheita referencia Activity, esta deve ser do mesmo Planting; máquinas/operador vêm de ActivityMachine, sem outra lista independente. Para registrar máquina numa colheita, associar uma atividade correspondente. São permitidas várias colheitas parciais por plantio.

Quantidade informada e peso não são duas produções somáveis: escolher quantidade líquida aprovada na unidade informada e normalizar quando houver conversão válida. Peso bruto, tara e perdas só entram se a metodologia estiver definida; não subtrair perdas duas vezes de um peso já líquido. Conforme D7 aprovada, não haverá ajustes automáticos de umidade/qualidade no primeiro MVP. Perda estimada não equivale a produto colhido disponível em estoque.

A decisão aprovada D7 adota **harvestedAreaHa** (área trabalhada no evento) e **newlyHarvestedAreaHa** (área distinta que entra no denominador pela primeira vez naquele plantio/ciclo), permitindo múltiplas passadas sem duplicar a área utilizada para produtividade. A primeira pode repetir em novas passadas; a segunda pode ser zero numa passada adicional e nunca excede a primeira. Cumulativo de área nova confirmada, líquido de reversões, não ultrapassa a área efetivamente plantada. Bloquear Planting durante confirmação/correção concorrente. Sem subgeometria, “área nova” é declaração validada operacionalmente; o banco não consegue inferir se dois hectares desenhados só como números são os mesmos.

Indicadores:

- Produtividade principal = produção líquida confirmada / área distinta colhida. Exemplo: `5.820 sc / 97 ha = 60 sc/ha`, com peso por saca explícito e consistente; não assumir universalmente 60 kg por saca.
- Produção por área plantada = produção líquida / área efetivamente plantada. É outro indicador e deve ter rótulo próprio, especialmente enquanto a colheita é parcial.
- Denominador zero/ausente retorna “não disponível”, não zero, infinito ou um resultado inventado.
- Consolidação por cultura/safra usa soma de produção compatível / soma de áreas distintas elegíveis; não média simples das produtividades. Não somar massa de soja e milho como produtividade agronômica única, nem sacas de pesos distintos sem normalizar.

Não persistir uma coluna manual de produtividade. Relatórios podem usar projeções/cache reconstruíveis com corte temporal e versão da metodologia. Planting preserva sua área executada e referência territorial; editar Field atual não muda o denominador histórico. Harvest confirmado é corrigido com reversão/substituição rastreável. Reversão integral referencia um único original confirmado do mesmo plantio, repete seus valores e tem efeito negativo; original e reversão permanecem confirmados e ambos entram na soma com seus sinais. “Revertido” é situação derivada dessa ligação, não motivo para excluir o original da soma e descontar a reversão novamente. Impedir duas reversões do mesmo original e reversão de reversão; correção publica um novo fato correto. O tratamento de múltiplas passadas está aprovado em D7.

## 13. Alertas internos

Categorias iniciais: LOW_STOCK, MAINTENANCE_DUE, ACTIVITY_OVERDUE, INPUT_EXPIRING, OPERATIONAL_INFORMATION. Severidades INFO, WARNING e CRITICAL são códigos de sistema. Não existem canais de e-mail, push ou WhatsApp nesta proposta de MVP.

Deduplicar por `(organizationId, escopo, categoria, origem, condição/janela)` para não criar um alerta a cada verificação. Estoque baixo compara saldo/projeção confiável com mínimo da InventoryItem; validade considera lote com saldo; atraso diferencia previsão de execução real. Fechar condição resolve Alert sem apagar histórico. Leitura individual futura usa AlertReceipt, não troca o estado compartilhado.

Alert de uma fazenda exige farmId e segue suas permissões. Um “alerta organizacional” não pode conter nome, quantidade ou localização de fazendas ocultas ao destinatário; resumos consolidados completos são para OWNER. sourceType/sourceId são referências polimórficas controladas: não possuem FK universal e precisam de validação de origem/tenant e projeção segura ao exibir.

## 14. Auditoria e metadados seguros

Auditar mudanças de acesso, convites, estado territorial, safras/plantios, confirmações/correções de execução, consumo, transferência, ajustes, colheitas e alterações administrativas. Um fato de negócio confirmado e seu AuditLog devem persistir na mesma transação; rollback não deixa log de “sucesso”. Falhas de acesso ficam em log de segurança separado, com conteúdo reduzido; não dar a um tenant acesso ao log técnico global.

Ator e timestamp são preenchidos pelo servidor. actorMembershipId preserva a ligação à pessoa na organização, mesmo após revogação; registro de ação não depende do nome atual ser igual ao da época. PLATFORM/SYSTEM usam referências controladas e auditáveis. Ações globais da identidade User que não pertencem a uma organização usam trilha de segurança da plataforma, não expõem dados de outras participações em AuditLog de cliente.

Before/after é um **diff de campos permitidos por tipo de evento**, não serialização de DTO, request, objeto Prisma ou entidade inteira. Exemplos permitidos: status anterior/novo, área validada, quantidade/unidade, referência do movimento e motivo reduzido. Excluir senhas, digests de credenciais/convites, tokens, links secretos, cabeçalhos, cookies, DATABASE_URL e configurações de infraestrutura. Sanitizar texto livre, limitar tamanho e evitar dados pessoais desnecessários. Geometrias grandes ficam em revisão territorial referenciada, não copiadas em todo log.

entityType/entityId são referência de evidência; não constituem FK genérica nem autorização para consultar a entidade. Referências são produzidas a partir de objetos previamente validados no tenant. Auditoria de fazenda tem farmId; registros organizacionais só são visíveis a capacidades administrativas. Exportações obedecem às mesmas restrições e são auditáveis.

Aplicação não atualiza/exclui AuditLog. Na implementação física, restringir privilégios e considerar trigger de bloqueio de alteração; acesso de manutenção/retention é separado e auditado. Um administrador do banco ainda pode alterar dados: append-only na aplicação não é prova criptográfica de inviolabilidade. Armazenamento externo imutável/assinatura não é necessário ao MVP sem exigência específica. Conforme D8 aprovada para o MVP, fatos confirmados são preservados e não podem ser apagados pelo usuário; uma política formal de retenção/desidentificação deverá existir antes da operação comercial em produção, sem prazos arbitrários nesta fase.

## 15. IDs, unicidade e índices

**Recomendação: UUID v4 como identidade pública e PK**, com tipo PostgreSQL `uuid`, geração criptograficamente aleatória e unicidade garantida pelo banco. Facilita criação distribuída e reduz enumeração sequencial. UUID v7 melhora localidade de inserção, mas revela ordenação/tempo aproximado; pode ser reavaliado após medir volume. IDs incrementais são compactos, porém previsíveis e menos convenientes para integração entre origens. Não criar dupla chave pública/interna agora sem necessidade. PostgreSQL 18 oferece geração de UUID v4/v7. [PostgreSQL: funções UUID](https://www.postgresql.org/docs/18/functions-uuid.html).

UUID não é segredo, token de convite nem verificação de acesso. Códigos humanos sequenciais (ex.: talhão 03) são atributos por escopo, não credenciais. Sequência interna do ledger serve para ordenar publicações, sem substituir o UUID exposto.

Unicidades propostas: email normalizado global de User; `(organizationId, userId)` em OrganizationMembership; `(organizationId, membershipId, farmId)` em FarmMembership; `(organizationId, systemCode)` para Role de sistema; `(roleId, permissionCode)`; códigos de Farm/Product dentro da organização e Field/Machine/Season dentro da fazenda; `(organizationId, farmId, productId)` em InventoryItem; linhas por documento/número; convite por digest; chaves de idempotência por tenant/tipo de comando. Código de exibição não substitui ID de lote; código do fabricante pode repetir entre origens e não é identificador universal.

Nomes/códigos normalizam espaço/case de forma definida, preservando apresentação. Proposta: códigos operacionais não são reutilizados depois da inativação, simplificando referências históricas; rascunhos eliminados sem referências podem liberá-los. Se houver unicidade apenas em registros ativos, ela exigirá índice parcial e tratamento explícito de reativação; não assumir que `deletedAt` numa chave única resolve nulls.

Índices iniciais candidatos: FKs compostas; `(organizationId, farmId, status)` em entidades consultadas por escopo; `(organizationId, farmId, plannedStartAt)` em Activity; `(organizationId, farmId, inventoryItemId, recordedAt, id)` no ledger; `(organizationId, farmId, plantingId, data)` em Harvest; `(organizationId, farmId, estado, severity)` em Alert; `(organizationId, timestamp, id)` e `(organizationId, entityType, entityId, timestamp)` em AuditLog. B-tree não indexa automaticamente toda FK; planejar os acessos sem duplicar índices já cobertos por PK/unique. Geometrias recebem GiST. Refinar com consultas reais, não indexar todo atributo por antecipação.

## 16. Exclusão, inativação e preservação histórica

Decisão D8 aprovada para o MVP: fatos confirmados não serão apagados pelo usuário, especialmente InventoryMovement, atividades executadas, transferências publicadas, Harvest confirmado e AuditLog. Cadastros operacionais com histórico normalmente serão inativados. Convites e dados temporários poderão ter política própria de expurgo. A política formal de retenção/desidentificação é requisito anterior à operação comercial em produção; nenhum prazo arbitrário é definido nesta fase.

| Grupo | Estratégia recomendada | Consequência |
| --- | --- | --- |
| Organization, User | Estado de ciclo de vida; encerramento/bloqueio, sem hard delete cotidiano | Revoga acesso sem destruir eventos. Retenção/desidentificação é processo separado. |
| Memberships | Suspender/revogar e registrar datas; manter linha | Histórico continua apontando ao vínculo original. Reativação é explícita e auditada. |
| Farm, Field, Crop, Product, Machine, Role | Inativação; sem apagar quando referenciados | Novas operações são bloqueadas, consultas históricas continuam autorizáveis. |
| Cadastros incompletos e rascunhos sem referências | Hard delete pode ser permitido antes da publicação | Validar inexistência de filhos relevantes e autorização; não usar cascata sobre fatos. |
| Drafts recuperáveis que precisarem de lixeira | Soft delete com deletedAt/deletedBy, apenas onde houver esse requisito | Todas as consultas/unique/reativação precisam tratar o estado; não adicionar deletedAt em tudo. |
| Season, Planting e Activity com histórico | Estado final/cancelamento e correções auditadas | Não apagar execuções, nem movimentações ao cancelar o pai. |
| InventoryMovement e transferências publicadas | Histórico imutável; compensações | Proibir UPDATE/DELETE operacional e cascatas destrutivas. |
| Harvest confirmado | Histórico preservado com reversão/substituição explícita | Indicadores calculam efeito líquido, mantendo autoria e evidência. |
| AuditLog | Append-only; retenção administrativa controlada | Não seguir soft delete/cascata da entidade afetada. |
| Alert | Resolver e manter histórico; expurgo por política | Leitura e resolução distintas; prazos deverão constar da política formal anterior à operação comercial em produção, conforme D8. |
| Invitation | Expirar/revogar; purgar digest após janela aprovada, manter evidência mínima | Não manter material de convite eternamente nem apagar rastreabilidade da concessão. |

FKs de fatos para cadastros usam RESTRICT/NO ACTION, não `ON DELETE CASCADE` de Farm/Organization para o ledger, atividades, colheitas ou auditoria. Cascata só é aceitável em componentes de rascunhos descartáveis sem história, após revisar seu alcance. Revogar acesso não significa ocultar evidência dos administradores que continuam autorizados. Renomear cadastro não muda fatos quantitativos; snapshots apenas onde a semântica histórica exige (área executada, unidade/fator, revisão territorial), evitando copiar toda entidade.

## 17. Invariantes: banco, aplicação e transações

Legenda: **declarativa** = PK/FK/unique/check/índice; **procedural** = SQL/trigger/privilégios planejados; **aplicação** = autorização/fluxo com transação. Nenhum mecanismo foi implementado nesta tarefa.

| Invariante | PostgreSQL pode garantir | Responsabilidade da aplicação |
| --- | --- | --- |
| Mesmo tenant/fazenda nas relações privadas | Declarativa: FKs compostas e chaves candidatas; checks para links opcionais | Validar contexto e IDs recebidos; mapear erros sem revelar registros de outro tenant |
| Leitura/escrita de linhas autorizadas | RLS e privilégios sob conexão corretamente limitada | Permissão de ação, conjunto de fazendas, contexto por transação, projeção segura |
| Cultura global ou do tenant | Check de escopo na linha; constraint trigger nos vínculos | Visibilidade de catálogo e autorização de manutenção |
| Um membership por user/tenant; conta única por farm/produto | Unique + FK | Reativação e conflitos de criação concorrente |
| Pelo menos um OWNER ativo em organização ativa | Trigger/procedimento com bloqueio; não CHECK simples | Fluxo de ativação e troca de proprietário na mesma transação |
| Áreas/quantidades válidas, fim não anterior ao início | Checks de mesma linha, NOT NULL condicional, tipos Numeric | Regras entre entidades e transições; números finitos/escala na entrada |
| Soma de ocupações dentro da capacidade, inclusive correções históricas | Trigger com protocolo de locks; não apenas CHECK | Cálculo por intervalos e validação ao alterar Field/Planting |
| Geometria com tipo/SRID/validade corretos | Typmod/checks PostGIS na linha | Limites de upload, revisão; contenção/interseção entre linhas sob transação |
| Saldo não negativo | Escritores controlados + locks/Serializable; trigger pode reforçar | Saldo total e por lote, conversões, autorização e tratamento de conflitos |
| Transferência completa e balanceada | Unique por lado + constraint trigger diferida; FKs coerentes | Criar ambos os lados/cabeçalho/linhas em uma transação; autorizar ambos os escopos |
| Reenvio não duplica efeitos | Unique da chave de idempotência e origem do fato | Conferir equivalência do payload, retornar resultado anterior ou conflito |
| Publicações e auditoria imutáveis | Privilégios/trigger, não apenas convenção de service | Operações de compensação; não reutilizar client administrativo no runtime |
| Unidade compatível; fator histórico preservado | FKs/checks positivos e bloqueio de alterações de fatos | Compatibilidade dimensional e contexto de saca; política de arredondamento |
| Área distinta de colheita dentro do plantio | Transação/trigger com bloqueio do Planting | Metodologia de passadas; comprovação operacional/espacial da área nova |
| Ator/responsável pode agir agora | FK prova vínculo, não autorização temporal | Membership/farm access ativos e permissão no instante da ação; preservar passado |

Operações que obrigatoriamente exigem transação na implementação: ativar organização/primeiro OWNER; aceitar convite/criar escopos; revogar/trocar último OWNER; alterar papel e concessões; iniciar/revisar ocupação e capacidade; finalizar atividade com consumos; devolver/estornar com limites cumulativos; publicar/reverter transferência; confirmar/corrigir colheita; revisar limites territoriais com dependentes. A auditoria do sucesso acompanha a mesma transação. Os locks devem ter ordem consistente e as transações devem ser curtas.

## 18. Revisão crítica e riscos identificados

| Risco/ambiguidade examinada | Resolução proposta ou limite explícito |
| --- | --- |
| User preso a um cliente; OWNER com poderes globais | User global + memberships; OWNER é posição por organização, não superuser da plataforma. |
| Role numa fazenda diverge do role de organização | Uma fonte de papel no MVP; acesso territorial separado. Papéis distintos por fazenda só com evolução explícita (D2). |
| Duplicação organizationId/farmId cria referências cruzadas | Duplicação apenas para escopo, vinculada por FKs compostas; diagramas simples não bastam. |
| Crop customizada de outro tenant parece catálogo público | Exceção global controlada, escopo imutável, políticas próprias e trigger de vínculo. |
| Atividade aponta a plantio/talhão/máquina inconsistentes | FKs compostas e checks condicionais; mesma Farm, Field do Planting e produto do consumo. |
| Dono pode ampliar suas próprias permissões fora do contrato | OWNER não altera tenant de recursos, catálogo global nem invariantes; papéis protegidos e ações delegáveis limitadas. |
| Soma de hectares passa no teste isolado mas falha em concorrência | Bloquear Field e considerar intervalos reais/históricos; soma não detecta desenho sobreposto. |
| Alterar geometria/área/máquina muda o passado | Revisões/snapshots necessários, fatos com escopo próprio e sem reparenting silencioso. |
| Planejamento baixa estoque; saldo vira coluna manual | Publicar movimentos só na execução; saldo e consumo efetivo são derivados. |
| Transferência de um lado só ou duplo clique mobile | Par de movimentos na mesma transação, idempotência e validação de integridade ao confirmar. |
| Lote, devolução e estorno permitem saldo ou compensação indevida | Saldos por conta/lote, referência ao original, limites cumulativos com locks. |
| Saca fixa, float ou peso+quantidade duplicam produção | Unidade dimensional, fator snapshot, Decimal e uma produção líquida canônica. |
| Somar áreas de passadas repetidas distorce produtividade | Separar área trabalhada de área nova; consolidar áreas distintas e unidades compatíveis (D7). |
| Soft delete/cascata apaga evidência | Inativação de cadastros, referências restritivas, ledger/colheitas/auditoria preservados. |
| Alerta, log ou exportação vaza fazenda sem autorização | Mesmo escopo das operações, allowlist de metadados e nenhuma identidade cross-tenant exposta. |
| RLS é presumida por usar Prisma/PostGIS | Ainda não existe; exige política, usuário de runtime limitado, contexto e testes negativos próprios. |

Critérios de aceitação para a futura implementação: tentativa de relacionar tenants/fazendas distintos rejeitada no banco; acesso indevido rejeitado inclusive em raw SQL/exportação; dois consumos concorrentes não tornam saldo negativo; duas ativações não excedem capacidade; transferência nunca fica unilateral; reenvio não repete efeito; colheita parcial não duplica área; desligar membro não apaga sua autoria. Esses testes futuros complementam, não substituem, a validação da documentação atual.

Pontos técnicos a detalhar na modelagem física, sem exigir novas escolhas de produto: representação de constraints/triggers fora do Prisma, políticas RLS por tabela, formatos de índices/idempotência e revisão de precisões com dados reais. Extensões não antecipadas como entrega MVP: Supplier, participantes, múltiplas sessões de máquina, telemetria, trânsito físico, notificações externas, reservas e custeio completo. As decisões D1–D8 abaixo foram aprovadas pelo usuário e não estão pendentes. D8 mantém a exigência de política formal de retenção/desidentificação antes da operação comercial em produção.

## Decisões arquiteturais aprovadas (D1–D8)

Registro da aprovação pelo usuário para o MVP. Estas decisões orientam a implementação futura; esta atualização é exclusivamente documental.

### D1 — Propriedade e coproprietários

**Status: APROVADA.**

- Uma Organization pode possuir múltiplos OWNER ativos; todos possuem visão completa da organização.
- No fluxo normal da aplicação, somente OWNER devidamente autorizado poderá promover/convidar outro OWNER.
- Uma organização ativa nunca poderá ficar sem pelo menos um OWNER ativo.
- Recuperação/provisionamento pela plataforma ocorre somente por procedimento administrativo separado e auditado.
- Não utilizar `ownerUserId` em Organization como fonte única de propriedade.

### D2 — RBAC

**Status: APROVADA.**

- Manter Role + Permission + RolePermission, com papéis iniciais OWNER, MANAGER, AGRONOMIST e WORKER. A matriz de permissões da seção 6 está aprovada.
- OWNER possui acesso organizacional completo; MANAGER, AGRONOMIST e WORKER dependem de FarmMembership para acessar fazendas.
- WORKER poderá registrar consumo e produção somente através das atividades que estiver autorizado/atribuído a executar.
- Cada OrganizationMembership possui um papel uniforme em todas as fazendas às quais tem acesso no MVP.
- Papéis diferentes por fazenda e permissões personalizadas ficam preparados arquiteturalmente, mas fora do primeiro MVP.

### D3 — Área e mapa

**Status: APROVADA.**

- A área declarada/validada será inicialmente a referência oficial de capacidade.
- Field poderá existir e operar sem geometria no MVP; o sistema deverá apresentar estado equivalente a “Talhão ainda não mapeado”.
- Quando existir geometria, calcular também a área geográfica, sem substituir automaticamente a declarada.
- Diferença superior a 2% entre a área declarada e a calculada exige revisão/sinalização, tomando a área declarada como referência conforme seção 7.2.
- Manter MultiPolygon/SRID 4326 como estratégia geoespacial.

### D4 — Ocupação

**Status: APROVADA.**

- Plantios simultâneos no MVP representam subdivisões exclusivas: num talhão de 100 ha, 60 ha de soja + 40 ha de milho são permitidos; 60 ha + 50 ha não são permitidos durante execução.
- Plantings apenas planejados não reservam capacidade de forma rígida; conflitos de planejamento poderão gerar aviso.
- Ao iniciar/confirmar ocupação efetiva, revalidar a capacidade e impedir excesso.
- Consórcio real sobre os mesmos hectares fica fora do primeiro MVP.

### D5 — Estoque

**Status: APROVADA.**

- Estoque negativo é proibido por InventoryItem e, quando aplicável, por lote.
- OWNER e MANAGER devidamente autorizados poderão realizar ajustes, sempre com motivo e auditoria.
- Movimentos publicados são imutáveis; correções são feitas por movimentos compensatórios.
- `occurredAt` representa quando o evento foi informado como ocorrido; `recordedAt` representa quando foi efetivamente registrado/publicado.
- Lançamentos tardios exigem motivo apropriado. No MVP, eles não provocam reconstrução retroativa de toda a sequência histórica de saldos.

### D6 — Transferências

**Status: APROVADA.**

- No MVP, transferência entre fazendas será imediata e atômica.
- Uma transferência publicada produz saída na fazenda origem e entrada na fazenda destino na mesma transação; nunca poderá existir somente um dos lados.
- Despacho, trânsito e aceite ficam para evolução futura.

### D7 — Colheita

**Status: APROVADA.**

- Adotar `harvestedAreaHa` e `newlyHarvestedAreaHa`, permitindo múltiplas passadas sem duplicar a área utilizada para produtividade.
- Produtividade principal: produção líquida confirmada / área distinta colhida. Produção / área plantada é indicador diferente.
- Peso de saca deve ser explícito quando necessário; não assumir universalmente 60 kg por saca.
- Não implementar ajustes automáticos de umidade/qualidade no primeiro MVP.

### D8 — Retenção

**Status: APROVADA para o MVP.**

- Fatos confirmados não serão apagados pelo usuário; preservar especialmente InventoryMovement, atividades executadas, transferências publicadas, Harvest confirmado e AuditLog.
- Cadastros operacionais normalmente serão inativados em vez de apagados quando possuírem histórico.
- Convites e dados temporários poderão possuir política própria de expurgo.
- Antes da operação comercial em produção deverá existir política formal de retenção/desidentificação.
- Não definir prazos arbitrários nesta fase.
