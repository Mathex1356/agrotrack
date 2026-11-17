# API de talhões — Sprint 2, Tarefa 02

Entrega cadastro e limites espaciais de Field sobre o schema existente. Preserva
D1–D8, migrations, checks, GiST, triggers e PostGIS. Não há geometria de Planting,
mapa frontend, nova Permission, RLS, AuditLog físico ou DELETE.

## Contrato e escopo

| Rota | Capacidade | Resultado |
| --- | --- | --- |
| POST /farms/:farmId/fields | fields.manage | 201, Field ACTIVE |
| GET /farms/:farmId/fields | farms.read | 200, página compacta |
| GET /farms/:farmId/fields/:id | farms.read | 200, detalhe com GeoJSON |
| PATCH /farms/:farmId/fields/:id | fields.manage | 200, detalhe atualizado |

Todas exigem JWT Bearer e CurrentContext server-side pelo header de membership.
`farms.read` já cobre operações/mapas no catálogo aprovado; não criar aliases.
WORKER com apenas `farms.read_assigned_work` recebe 403 nesta projeção completa.
OWNER precisa da capacidade, mas tem território org-wide da organização atual;
demais papéis exigem FarmMembership ACTIVE. A lógica fica em AuthorizationService.

Farm é buscada por AND entre o scope autorizado e farmId. Todo acesso a Field,
inclusive SQL espacial, restringe organizationId **e farmId e, no detalhe, id**.
Farm invisível/inexistente recebe 404 também na listagem, nunca página vazia que
possa mascarar IDOR. Field de outra fazenda/tenant, ausente ou ID malformado tem
a mesma resposta 404. organizationId e farmId não são editáveis pelo body/query.

POST exige code, name e areaHa; opcionais soilType, description, notes e boundary.
Cria ACTIVE; status no POST é rejeitado. PATCH aceita subconjunto não vazio e
status ACTIVE/INACTIVE. Apenas textos opcionais e boundary aceitam null; omissão
preserva valor. Allowlist rejeita campos desconhecidos, relações, timestamps,
geometryRevision, áreas calculadas e dados de tenant.

Code tem trim/uppercase e limite 64; name 160; soilType 160; description/notes
2000 caracteres. Textos não vazios, sem controles. areaHa é string Decimal
positiva, até 12 dígitos inteiros e seis frações, sem expoente, sinal, espaços,
número JSON ou arredondamento silencioso. Área declarada continua capacidade
oficial e nunca é substituída pela geográfica.

GET lista aceita somente limit 1–100 (20 padrão), offset 0–10000 (0 padrão),
ordena id ASC e devolve items/limit/offset/hasMore. Lista traz id, farmId, code,
name, areaHa, status, geometryRevision, timestamps e derivados de área; não
carrega boundary nem textos extensos. Detail/POST/PATCH acrescentam boundary,
soilType, description e notes. Não expõem organizationId nem relações internas.
As demais rotas rejeitam qualquer query parameter.

## Transporte geográfico

boundary é GeoJSON **Geometry** Polygon ou MultiPolygon, apenas type/coordinates.
Polygon é promovido a MultiPolygon sem alterar a forma. Não aceitar Feature,
FeatureCollection, crs, srid, bbox, coordenadas 3D, strings numéricas, NaN/Infinity,
arrays vazios ou anéis abertos/com menos de quatro posições. Posições são números
finitos `[longitude, latitude]` WGS84, longitude [-180,180], latitude [-90,90].
Sem CRS alternativo: atribuir 4326 não é transformar coordenadas projetadas.

Limites globais por geometria: 256 posições, 32 anéis, 16 polígonos. O parser
HTTP continua limitado a 8 KiB, inclusive auth; grandes uploads recebem 413.
Não há simplificação, ST_MakeValid ou reparação automática. PostGIS valida
topologia com `ST_IsValid(geometry,0)` sem NOTICE sensível. Buracos e polígonos
descontínuos são permitidos quando topologicamente válidos.

Armazenamento único é `geometry(MultiPolygon,4326)` opcional, já existente.
GeoJSON é transporte, não segunda coluna. O adaptador `field-boundary.ts` usa
SQL parametrizado; metadata Prisma e geometria são gravadas na mesma transação.
Qualquer falha espacial reverte também nome/área/status, sem mudança parcial.

Projeção usa `ST_AsGeoJSON(boundary,17,0)`. Dezessete casas não garantem todo double:
PostGIS preserva valores muito pequenos por notação científica, mas alguns
valores intermediários próximos de zero perdem dígitos na saída decimal. Antes
de gravar, a projeção reimportada deve continuar válida e `ST_Equals` à original;
caso contrário 400, em vez de mudar silenciosamente a forma. A geometria original
é persistida, não a reimportada. Testes incluem ambos os comportamentos reais.

Geometria legada inserida por SQL que não possa ser projetada sem alterar a forma
gera 409 seguro no detalhe e nas respostas completas de mutação; lista compacta
permanece disponível. O dado não é alterado automaticamente. PATCH pode remover
ou substituir boundary explicitamente; falha na projeção também reverte metadata.

Metadados, boundary, revisão e área derivada vêm de **uma projeção SQL**, garantindo
snapshot consistente dentro da resposta, sem N+1 na lista. Cálculo de hectares:
`ST_Area(boundary::geography) / 10000`, nunca área angular de geometry 4326.

Derivados:

- mapped: boundary presente; ausência representa “Talhão ainda não mapeado”.
- calculatedAreaHa: string com seis casas HALF_UP, ou null sem boundary.
- areaDifferencePercent: `abs(calculada-declarada)/declarada*100`, string seis
  casas HALF_UP, ou null sem boundary.
- areaNeedsReview: diferença **antes do arredondamento** > 2; false sem boundary.

Não há coluna calculada persistida nem sistema de alertas. Cálculo espacial usa
aproximações do PostGIS; Decimal preserva os números retornados para comparação
e apresentação, não aumenta precisão do levantamento.

## Escrita, capacidade e concorrência

Todas as escritas Fields seguem Farm FOR UPDATE → Field FOR UPDATE quando existe.
Após esperar lock, revalidam autorização e releem os valores atuais. Farm INACTIVE
retorna 409 para escrita; leituras históricas autorizadas permanecem disponíveis.

Criar, reativar ou mudar a área de Field ACTIVE exige soma dos Fields ACTIVE
(excluindo a linha atual) + nova área <= Farm.totalAreaHa. O mesmo lock Farm usado
pelo PATCH /farms serializa redução de fazenda e edição/criação de talhão.
Metadata-only não é bloqueada por drift legado de capacidade preexistente.
Não prometemos enforcement contra SQL/escritores externos que ignorem o protocolo;
novos caminhos de escrita devem adotá-lo. Não há trigger agregado novo.

PATCH grava somente campos enviados após validar os valores combinados atuais;
requisições de campos diferentes não sobrescrevem alterações omitidas. Escritas
no mesmo campo seguem ordem dos locks, sem ETag. O trigger existente preserva
área individual de Planting, inclusive histórico; redução incompatível recebe
409 por validação amigável antes da escrita. Inativar Field preserva Planting.
A soma temporal de plantios simultâneos (D4) continua fora desta tarefa.

geometryRevision é exclusivamente do trigger: zero na criação sem geometria, incrementa
em alteração de bytes/remoção, não em no-op. Não é contador enviado pelo cliente,
histórico ou snapshot. Editar geometria não reescreve áreas declaradas nem dados
de Planting. Futura auditoria/revisão territorial deverá preservar snapshots;
não foi inventada uma proibição geral de edição por existir Planting.

## Erros e limitações

400 entrada/GeoJSON inválido; 401 identidade/sessão; 403 contexto/capacidade;
404 recurso inexistente ou invisível; 409 unicidade, estado/capacidade incompatível
ou conflito transacional conhecido; 413 body excessivo. Erros internos são
sanitizados pelo filtro existente; sem credenciais, tokens ou SQL em respostas/logs.

Sem RLS, autorização continua responsabilidade server-side. Mudanças de acesso
afetam novas verificações e são rechecadas após locks, mas não cancelam atomicamente
uma operação já iniciada. Sem autorização baseada somente em UUID ou frontend.
Não se verifica sobreposição física entre Fields, contenção em limite Farm ou
ocupação temporal de Plantings nesta entrega.

## Testes

`fields.integration.test.mjs` usa HTTP Nest, PostgreSQL e PostGIS reais; fixtures
comuns fazem rollback. Concorrência usa fixtures isoladas confirmadas/removidas
e observa a cadeia `pg_blocking_pids` antes de liberar os escritores. Cobre
capacidade entre Fields, Field vs redução Farm e PATCHs no mesmo Field; também
IDOR, memberships, permissões, GeoJSON/precisão, revisão, rollback, projeção,
histórico e validação. Os 151 testes anteriores continuam obrigatórios.

## Evolu��o Sprint 2, Tarefa 04 � D4

A redu��o de areaHa tamb�m verifica o pico temporal hist�rico via fun��o
planting_occupation_peak, com NUMERIC exato, e retorna 409 quando incompat�vel.
O novo trigger de PostgreSQL protege essa regra inclusive em SQL direto; preserva
as valida��es individuais e o protocolo Farm ? Field. Esta prote��o � de ocupa��o
de Planting; n�o amplia a garantia da soma de Fields contra Farm para SQL externo.
Ver [API de plantios](plantings-api.md) para intervalos semiabertos, hist�rico,
matriz de estados e concorr�ncia. As limita��es temporais descritas na entrega
original acima foram superadas por esta migration; geometria permanece inalterada.
