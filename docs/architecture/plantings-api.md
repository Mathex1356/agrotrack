# API de plantios e capacidade temporal — Sprint 2, Tarefa 04

## Contrato HTTP

| Endpoint | Permission | Resultado |
| --- | --- | --- |
| POST /farms/:farmId/plantings | plantings.manage | 201, PLANNED |
| GET /farms/:farmId/plantings | farms.read | 200, página |
| GET /farms/:farmId/plantings/:id | farms.read | 200, detalhe |
| PATCH /farms/:farmId/plantings/:id | plantings.manage | 200, planejamento editado |

Reutiliza AuthGuard, PermissionGuard, CurrentContext e AuthorizationService. OWNER
continua sujeito à Permission e fica limitado à organização atual. Outros papéis
exigem FarmMembership ACTIVE. WORKER não recebe novas capacidades. Nenhum DELETE,
transição operacional, frontend, geometria de Planting ou nova Permission.

Organização vem exclusivamente do contexto validado. Farm vem da rota autorizada.
Consultas de Planting incluem organizationId, farmId e id quando aplicável; Field
e Season precisam da mesma fazenda; Crop GLOBAL ou privada da organização.
Recurso inexistente ou invisível recebe 404 uniforme, sem revelar outro tenant.

## Entrada e representação

POST exige fieldId, seasonId, cropId, plannedAreaHa e plannedStartDate. Aceita
variety, expectedEndDate, spacingMeters, populationPerHa e notes opcionais.
PATCH aceita somente esses campos de planejamento, excluindo os três IDs de
relacionamento, e apenas quando o registro continua PLANNED. Campos omitidos são
preservados; opcionais aceitam null. Status, dados reais, tenant, farmId,
timestamps e propriedades desconhecidas são rejeitados. Body vazio é inválido.

Variety tem até 160 caracteres e notes 2000, com trim, sem texto vazio ou controles.
UUIDs de referências inválidos no body/query retornam 400; IDs de rota inválidos
retornam 404. Datas civis YYYY-MM-DD, anos 0001–9999, sem rollover automático;
expectedEndDate >= plannedStartDate. Datas não precisam caber na previsão da Season.

Áreas e espaçamento são strings decimais positivas, até 12 dígitos inteiros e seis
fracionários; população até 14 inteiros e seis fracionários. Sem float, expoente,
NaN, sinal, espaços, JSON number ou arredondamento silencioso. Respostas usam strings
Decimal e datas civis; atualizações não alteram área ou datas reais.

GET lista aceita limit 1–100 (padrão 20), offset 0–10000 (padrão 0), fieldId,
seasonId, cropId e status. Ordenação id ASC; retorna items/limit/offset/hasMore.
Filtros nunca ampliam o escopo. Outras rotas rejeitam query parameters.
A projeção explícita não expõe organizationId nem relações internas completas.

## Pais e ciclo de vida

Escrita exige Farm, Field e Crop ACTIVE, Season PLANNED ou IN_PROGRESS.
Leituras históricas permanecem disponíveis com pais inativos ou safras encerradas.
POST atribui PLANNED e dados reais nulos. PATCH de outro estado retorna 409.
Iniciar, finalizar, cancelar, reabrir e corrigir execução exigem futuro fluxo
operacional auditado; não foram implementados por HTTP.

Checks do banco: PLANNED sem dados reais; IN_PROGRESS com área/início reais e sem
fim; FINISHED com área/início/fim; CANCELLED sem execução ou com os três campos.
Fim real, quando presente, deve ser estritamente posterior ao início. É a primeira
data desocupada, sem ajuste automático de +1 dia. DATE não representa horas.
Uma execução existente não pode perder área/início reais para apagar ocupação.

## D4 e PostgreSQL

Migration `20261016120000_planting_temporal_capacity` não altera schema.prisma,
colunas, migrations anteriores ou PostGIS. PostgreSQL calcula a ocupação por
Field com eventos +actualAreaHa no início e -actualAreaHa no fim. Agrupa deltas
por data antes da soma acumulada, usando NUMERIC exato, e compara o pico com areaHa.
Intervalos são [actualStartDate, actualEndDate); fim nulo é aberto. PLANNED não
reserva capacidade. FINISHED e CANCELLED executados continuam ocupando seu passado.
Não somar todos os intervalos que apenas intersectam um período; não proibir
sobreposição: 60+40 cabe em 100, 60+50 não cabe, intervalos adjacentes são válidos.

Triggers AFTER enxergam o resultado do comando, inclusive múltiplas linhas,
sem somar OLD e NEW. A redução de Field protege também o pico histórico. O
serviço Fields usa a mesma função para apresentar 409 antes da atualização;
o trigger é o árbitro final contra escritores SQL comuns que ignorem a aplicação.
O banco também continua protegendo a área individual planejada/real.

## Concorrência e limites

API usa Farm FOR UPDATE ? Field FOR UPDATE ? Planting FOR UPDATE quando existente.
Season/Crop são bloqueados FOR SHARE antes de validar estado; autorização é relida
após as esperas. Em PATCH, relacionamento relido diferente do Field bloqueado
provoca conflito, evitando operar sob lock territorial obsoleto.

O trigger preserva UPDATE sem mudança de hectares em Field: gera versão MVCC e
serializa alterações de ocupação, inclusive datas/status. Read Committed relê o
estado confirmado; Repeatable Read com snapshot antigo deve abortar por serialização.
Não substituir essa escrita por um simples SELECT FOR UPDATE. Escritas diretas
em ordem diferente podem causar deadlock; aborto reverte a transação inteira.
Conflitos Prisma P2034 e SQLSTATE 40001/40P01 conhecidos viram 409. Não há retry
cego automático: retry deve reiniciar toda transação, reler/autorizá-la e exigir
idempotência antes de repetir futuros comandos operacionais. PATCH de campos
distintos preserva omitidos; mesmo campo segue ordem dos locks, sem ETag.

400 entrada; 401 identidade; 403 contexto/capacidade; 404 invisível/inexistente;
409 estado/área/conflito conhecido; 413 limite HTTP global. Erros internos seguem
filtro sanitizado, sem SQL, parâmetros, tokens ou credenciais.

Ainda não há ocupação segmentada, execução parcial temporal, auditoria física,
política completa contra edição/exclusão privilegiada de fatos, RLS ou validação
espacial de subáreas. Cada Planting representa área constante no intervalo real.
Revogação de acesso é revalidada mas não cancela atomicamente operação já iniciada.
D4 protege integridade de capacidade, não substitui autorização nem auditoria.

## Validação

Testes HTTP reais estão em plantings.integration.test.mjs; capacidade SQL,
intervalos, matriz de estados, rollback, comandos multirrow e concorrência em
Read Committed/Repeatable Read em planting-capacity.integration.test.mjs.
Fields possui regressão de redução abaixo do pico histórico. Suite completa deve
rodar com arquivos sequenciais; cenários internos de concorrência continuam reais.
