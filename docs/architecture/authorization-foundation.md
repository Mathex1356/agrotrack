# Fundação de autorização

Implementa Permission e alcance territorial sobre o modelo existente, sem nova
migration, catálogo, entidade ou endpoint de negócio. Preserva D1–D8 e D-AUTH-01/02.

## Fronteiras e contexto

Authentication identifica o User global e sua sessão. CurrentUser contém userId
e sessionId. CurrentContext acrescenta membershipId, organizationId e roleId,
validados server-side pelo AuthGuard; o header de membership apenas solicita
contexto. Permission define capacidade; FarmMembership define território.

AuthorizationService revalida os cinco IDs e estados no banco: sessão não
revogada/não expirada, User ACTIVE, membership do User e tenant informados ACTIVE,
Organization ACTIVE e Role ACTIVE do mesmo tenant. Um objeto antigo, parcial ou
com IDs trocados não dispensa essas verificações. O serviço é uma API interna,
não um autenticador de objetos enviados pelo cliente: controllers devem passar
CurrentContext produzido pelo guard, nunca converter um body/header em contexto.

O JWT permanece global, sem listas de permissões ou fazendas. Não há cache de
autorização. Novas verificações enxergam revogações confirmadas no banco, inclusive
troca de Role e remoção de RolePermission, sem reemitir o access token.

## Catálogo e capacidade

`authorization/permissions.ts` oferece PERMISSIONS e a união tipada PermissionCode
para os mesmos 25 códigos de `prisma/permissions.mjs`; teste de paridade protege
essa correspondência. Não foram criadas permissões adicionais. O seed continua
idempotente e preserva seu comportamento anterior: reconcilia inclusive status
ACTIVE das capacidades conhecidas. Não usar reexecução de seed como manutenção
rotineira durante uma desativação operacional de Permission.

RolePermission concede somente capacidades conhecidas e ativas, vinculadas ao
Role/Organization atuais. Ausência de concessão, código desconhecido ou lista
vazia nega. Não há fallback baseado no nome do papel, nem bypass de capacidade
para OWNER: ele recebe a matriz completa no provisionamento, mas uma concessão
removida ou Permission inativa também o impede.

## API declarativa e serviço

Módulos futuros importam AuthorizationModule, que reutiliza PrismaModule e
exporta AuthorizationService/PermissionGuard. AuthGuard global executa antes
do PermissionGuard local. Exemplo para uma capacidade organizacional:

```ts
@RequirePermission(PERMISSIONS.MEMBERS_MANAGE)
@Get()
list(@CurrentContext() context: OrganizationContext) {
  return this.members.list(context); // consulta sempre restrita ao tenant
}
```

RequirePermission compõe RequireOrganization e PermissionGuard. Vários códigos,
declarações na classe e no método, e decorators repetidos são cumulativos AND.
Uma declaração vazia ou inválida nega; PermissionGuard sem metadata também nega.
Public combinado indevidamente com Permission não libera acesso: sem identidade
validada o guard local responde 401. Não combinar essas declarações.

Para serviços, estão disponíveis:

```ts
await authorization.requirePermission(context, PERMISSIONS.MEMBERS_MANAGE);
await authorization.requirePermissions(context, [PERMISSIONS.FIELDS_MANAGE, PERMISSIONS.PLANTINGS_MANAGE]);
await authorization.requireFarmAccess(context, farmId); // SOMENTE território
await authorization.requireFarmPermission(context, farmId, PERMISSIONS.FARMS_READ);
```

Para operação de fazenda, preferir requireFarmPermission, que compõe capacidade
e território sem repetir a resolução de contexto dentro da chamada. O decorator
de capacidade isolado NÃO verifica território. Não há decorator farmId automático:
a camada de aplicação deve resolver a fazenda de recursos indiretos como
Planting → Field → Farm, por consultas restritas ao tenant, e passar o ID canônico
ao serviço antes de expor dados ou escrever. Não confiar em um farmId auxiliar
enviado pelo cliente quando o recurso pertence a outra fazenda.

## OWNER e FarmMembership

O serviço lê systemCode fresco do Role validado. OWNER alcança todas as fazendas
da organização atual sem FarmMembership; uma fazenda de outro tenant sempre
falha. Nome de papel “OWNER” ou systemRoleCode acrescentado ao contexto não tem
efeito. MANAGER, AGRONOMIST, WORKER e papéis sem systemCode exigem FarmMembership
ACTIVE do membership atual, da fazenda solicitada e da mesma organização.

Capacidade sem território não basta; território sem capacidade também não.
Farm INACTIVE não elimina autorização territorial, preservando acesso histórico.
Isso não permite novas operações em fazenda inativa: pré-condições de cada fluxo
devem validar seu estado. Atividade atribuída ao WORKER, escopo técnico do
AGRONOMIST, proteção de papéis e ambas as pontas de transferências continuam
predicados de domínio obrigatórios, não implicados apenas pela Permission.

## Negação e exposição de existência

- 401: identidade/sessão ausente, inválida, bloqueada, revogada ou expirada.
- 403: contexto incompatível/inativo, capacidade ausente ou território negado.
- O verificador territorial devolve o mesmo 403 para UUID inválido, ID inexistente
  e fazenda de outro tenant; não informa o motivo específico ou dados da fazenda.
- Futuros endpoints de detalhe devem consultar por ID **e organizationId**, mais
  o escopo de fazendas autorizado quando aplicável, e retornar o mesmo 404 para
  inexistência ou recurso invisível. Não buscar globalmente para revelar depois
  que pertence a outro cliente. Sem CRUDs nesta entrega, nenhum novo 404 público
  foi introduzido.

Esconder botões é UX, nunca segurança. IDs/UUIDs não provam autorização. Consultas
raw, listagens, contagens, exportações e IDs relacionados precisam do mesmo escopo;
autorizar uma fazenda não autoriza uma consulta irrestrita à organização inteira.

## Consistência, custo e limites

Cada chamada de capacidade faz duas operações Prisma: sessão e membership com
concessões pedidas. A composição com fazenda acrescenta uma consulta territorial
com filtro de vínculo, sem percorrer uma lista de fazendas. Prisma pode decompor
relações em SQL adicional; o trabalho é limitado pelas capacidades solicitadas,
sem consulta por item de resultado. Decorators na classe e método podem executar
o mesmo guard mais de uma vez; preferir uma declaração no nível adequado quando
não houver requisitos adicionais. Nenhum cache entre requisições foi introduzido.

Não há lock que cancele uma operação já autorizada quando uma revogação concorre.
Fluxos sensíveis futuros precisam revalidar dentro da transação de escrita e
definir seu protocolo de concorrência. Esta fundação não promete serialização
atômica entre autorização e mutação, nem constitui RLS. Não reutilizar contexto
ou decisão armazenados para processar jobs arbitrariamente depois.

Não implementados: CRUDs, autorização completa dos domínios, customização de
papéis, RLS, cache/Redis, auditoria física ou mudança de JWT/refresh/autenticação.
As rotas atuais de identidade/contexto continuam com seus contratos anteriores;
não exigem uma capacidade agrícola inventada. Endpoints futuros devem declarar
capacidade e aplicar território/predicados pertinentes antes de acessar dados.

## Testes

`authorization.integration.test.mjs` usa PostgreSQL real e um harness Nest/HTTP
definido apenas no arquivo de teste, com JWT assinado e sessão persistida. Cada
cenário cria fixtures numa transação e faz rollback, inclusive papéis de sistema
protegidos; nenhum trigger é desabilitado ou dado demo confirmado. Testa catálogo,
guards, composição, revogações, tenant isolation, OWNER, papéis comuns, contexto
forjado/incompleto e semântica HTTP. Os testes anteriores permanecem necessários
para demonstrar integridade SQL e regressões de autenticação/PostGIS.
