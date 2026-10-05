# Fundação de autenticação e contexto

Implementa D-AUTH-01 e D-AUTH-02 aprovadas. Identidade é global; organização nunca
é atributo autoritativo do JWT ou da sessão. Nenhuma decisão D1–D8 é alterada.

## Contrato HTTP

| Rota | Contexto exigido | Comportamento |
| --- | --- | --- |
| GET /health | Público | Conectividade real do banco |
| POST /auth/login | Origin/CSRF e email/senha | Cria sessão global, cookie e access token |
| POST /auth/refresh | Origin/CSRF e cookie | Rotaciona refresh e emite access token |
| POST /auth/logout | Origin/CSRF e cookie | Revoga sessão; limpa cookie; 204 idempotente |
| GET /auth/me | CurrentUser | Retorna somente id, displayName e email próprios |
| GET /auth/memberships | CurrentUser | Lista somente vínculos próprios ativos com organização/papel ativos |
| GET /auth/context | CurrentUser + CurrentContext | Retorna contexto validado da requisição |

O guard global exige autenticação por padrão. `@Public()` é exceção explícita;
`@RequireOrganization()` acrescenta contexto. Isso ainda não concede permissões
de domínio: futuros endpoints devem verificar Permission e FarmMembership em
todas as operações, inclusive IDs relacionados e consultas raw. Não há RLS.

### D-AUTH-01 — membership por requisição

`X-Organization-Membership-Id` solicita uma seleção. O guard verifica assinatura,
issuer, audience, tipo, algoritmo e expiração JWT; consulta sessão não revogada e
não expirada e User ACTIVE. Depois procura membership pertencente a esse usuário,
ACTIVE, com Organization ACTIVE e Role ACTIVE da mesma organização. Somente então
cria um objeto congelado CurrentContext com userId, sessionId, organizationId,
membershipId e roleId. IDs inválidos, inexistentes ou de outros usuários recebem
o mesmo 403. Headers organizationId/farmId não criam contexto.

Não há seleção persistida na sessão. Abas concorrentes podem selecionar memberships
diferentes sem interferência. Checagens são por requisição, sem cache de papéis.
Fluxos futuros de escrita deverão revalidar autorizações dentro de sua transação
quando concorrerem com revogação; este guard não promete cancelar trabalho já iniciado.

## Senha, sessão e tokens

PasswordCredential tem relação global 1:1 com User. Argon2id usa 64 MiB, três
iterações e paralelismo 1; salt é gerado pela biblioteca. O hash PHC não vai a DTOs
ou logs. A consulta de login é normalizada com trim/lowercase, sem aliases de provedor.
Usuário inexistente/sem credencial usa hash dummy com mesmo custo; senha errada e
usuário bloqueado retornam o mesmo 401. Senha de login não é truncada nem normalizada;
limite de 1024 bytes e body JSON de 8 KiB limitam entradas abusivas. Estes limites
não são uma política de cadastro de senha; provisionamento será etapa própria.

AuthSession contém User, criação, vencimento absoluto e revogação. RefreshToken
guarda apenas SHA-256 de 32 bytes aleatórios CSPRNG, criação, vencimento, consumo e
sessão. A alta entropia permite digest rápido; isto não seria adequado para senha.
Histórico consumido é preservado para detectar replay. Access JWT HS256 curto
contém sub, sid, iat, exp, issuer/audience fixos e typ=at+jwt; segredo independente
com no mínimo 32 bytes. Nenhuma organização/papel é embutida como autoridade.

Refresh e logout bloqueiam a mesma linha AuthSession em transação. Refresh relê
o token após obter o lock, consome o anterior e insere o sucessor atomicamente.
Replay, expiração ou User bloqueado revogam a sessão; a transação confirma ANTES
de responder 401. Duas renovações simultâneas produzem um sucesso e um replay que
revoga toda a sessão, inclusive o sucessor. O cliente deve serializar refresh
entre abas; não há grace period que permita reutilização silenciosa. Falha de rede
após rotação pode exigir novo login. Logout usando cookie antigo ainda revoga a
sessão. Revogação é consultada em cada acesso, não apenas no refresh.

Vencimento do sucessor e do JWT é limitado ao vencimento absoluto da sessão.
Padrões configuráveis: access 300 s (máximo 900), refresh 7 dias, sessão 30 dias.
Rotação de segredo JWT invalida JWTs anteriores; plano de chaves múltiplas/kid é
evolução operacional, não implementado. Sessões não armazenam tokens utilizáveis.

### D-AUTH-02 — browser, cookie e CSRF

Refresh é cookie host-only (sem Domain), HttpOnly, SameSite=Strict, Path=/auth.
Em produção exige Secure e nome `__Secure-agrotrack_refresh`; desenvolvimento usa
`agrotrack_refresh` sem Secure para HTTP local. Nunca é retornado no JSON. O access
Bearer será mantido somente em memória pelo futuro frontend, não localStorage.

Todos os POSTs auth, inclusive login/logout, exigem Origin exata na allowlist,
`X-AgroTrack-CSRF: 1` e Content-Type application/json. Origin ausente, null ou
desconhecida é rejeitada. O header não é segredo: força preflight, e combinado
com validação de Origin impede submissões simples e requisições cross-origin
não autorizadas. CORS permite somente origens configuradas, headers explícitos
e credentials; CORS sozinho não é usado como autorização. HttpOnly e SameSite
são camadas adicionais, não substituem CSRF. XSS na origem confiável ainda é risco.

Produção: frontend e API em HTTPS no mesmo site, possivelmente app/api em subdomínios.
Allowlist deve listar ORIGENS completas do frontend, sem wildcard, path ou barra
final. Origem HTTP é rejeitada quando NODE_ENV=production. Não misturar ambientes.
Local: localhost:5173 com localhost:3000, ou 127.0.0.1:5173 com 127.0.0.1:3000.
Portas diferentes funcionam com CORS e fetch credentials='include'; localhost e
127.0.0.1 NÃO são o mesmo site. Para Vite em IPv4 explícito:
`npm run dev --workspace=@agrotrack/web -- --host 127.0.0.1`.

Proxy trust é false: X-Forwarded-For não altera IP de rate limit. Produção atrás de
proxy precisa configuração restrita aos proxies conhecidos em etapa de implantação;
não habilitar trust proxy=true arbitrariamente. Sem essa configuração todos os
clientes atrás do proxy compartilham limite (seguro, mas afeta disponibilidade).

## Brute force e erros

AuthRateLimit usa upsert PostgreSQL atômico com janelas fixas compartilhadas entre
instâncias. Login limita IP antes de chave de email e antes de Argon2; refresh e
logout também limitam IP. Chaves são HMAC-SHA256 com segredo independente; não
guardam email/IP bruto. Sucesso não apaga tentativas. Padrões: 30/IP e 10/email a
cada 900 segundos; refresh/logout 60/IP. 429 é genérico. Janelas fixas permitem
rajada na fronteira; defesa de borda/WAF e observabilidade são necessárias antes
de produção em escala. Ataque a uma conta pode limitar login legítimo temporariamente.

Limpeza oportunista remove até 1000 buckets expirados por minuto por instância.
Histórico de refresh NÃO é limpo automaticamente: preservar até término da sessão
e definir retenção formal junto a D8 antes da operação comercial. Crescimento e
limpeza operacional são responsabilidades explícitas, sem prazo arbitrário inventado.

Respostas usam no-store. Filtro global sanitiza erros inesperados e parser 400/413,
sem registrar exceções Prisma/crypto (que podem conter parâmetros). Não registra
senhas, hashes, cookies, JWTs ou digests. Observabilidade futura deve emitir somente
eventos allowlist/redigidos; desabilitar captura de bodies/headers sensíveis no proxy.

## Persistência, configuração e validação

Migration `20261003170000_auth_foundation`: quatro tabelas, FKs RESTRICT para
User e AuthSession, checks de digest/formato Argon2id/datas/contadores e índices
de consulta/manutenção. Nenhuma tabela contém organizationId: contexto territorial
continua em OrganizationMembership e suas FKs compostas preservadas. Checks não
substituem biblioteca criptográfica nem protocolo transacional da aplicação.
Migrations anteriores e PostGIS permanecem intactos; não há backfill/usuários demo.

`.env.example` documenta NODE_ENV, AUTH_JWT_SECRET, AUTH_RATE_LIMIT_SECRET,
AUTH_ALLOWED_ORIGINS, três TTLs e limites. Gerar segredos independentes e aleatórios
base64url com crypto.randomBytes(32); nunca copiar placeholders para produção.
Ausência/invalidez impede startup com mensagem segura. CLI Prisma e seed continuam
dependendo apenas de DATABASE_URL. Não existe cadastro público nem endpoint de
provisionamento de credencial; usuários atuais sem credencial não podem fazer login.
Testes criam e removem somente fixtures exclusivas em PostgreSQL local.

Executar comandos existentes prisma:format, prisma:validate, prisma:generate,
db:migrate, db:seed, test:api, lint, build e db:check. A suíte auth cobre HTTP real,
cookies/CSRF, parser, JWTs, estados, isolamento, replay, concorrência, revogação e
limite compartilhado, além dos testes anteriores do núcleo e PostGIS.

Fora desta tarefa: recuperação de senha, confirmação email, MFA, OAuth, frontend,
CRUD/provisionamento público, convites, autorização completa de domínios, auditoria
física, RLS, troca de senha e revogação administrativa/listagem de sessões.
