# Loja numismática Cloud 3.0

Versão preparada para **hospedagem gratuita** usando:

- **Render Free**: servidor Node.js/Express e HTTPS.
- **Supabase Free**: PostgreSQL persistente + Storage das fotos.
- **Google Authenticator**: 2FA TOTP do administrador.

O Render gratuito possui sistema de arquivos efêmero. Por isso esta versão **não usa SQLite nem salva fotos no disco do Render**. Produtos, pedidos, sessões, estoque e auditoria ficam no PostgreSQL do Supabase; fotos ficam no Supabase Storage.

## 1. Criar o projeto no Supabase

1. Acesse https://supabase.com e crie um projeto Free.
2. Aguarde o banco ficar pronto.
3. Abra **SQL Editor** > **New query**.
4. Abra o arquivo `supabase/setup.sql` deste projeto, copie TODO o conteúdo, cole no editor e clique em **Run**.
5. O SQL cria tabelas, índices, funções transacionais, RLS e o bucket `product-images`.

## 2. Pegar URL e chave secreta do Supabase

No Supabase, abra **Project Settings > API Keys** (ou o diálogo **Connect**):

- copie a **Project URL** -> será `SUPABASE_URL`;
- crie/copie uma **Secret key** com prefixo `sb_secret_...` -> será `SUPABASE_SECRET_KEY`.

**Nunca coloque a Secret key no HTML, JavaScript público, GitHub ou mensagens.** Ela só deve existir como variável secreta do Render ou no seu `.env` local.

A antiga `service_role` também funciona pela variável `SUPABASE_SERVICE_ROLE_KEY`, mas a Secret key nova é preferível.

## 3. Publicar o código no GitHub

Crie um repositório privado ou público no GitHub e envie os arquivos desta pasta. **Não envie `.env`** (ele já está ignorado no `.gitignore`).

## 4. Criar o serviço gratuito no Render

No Render:

1. **New > Blueprint** e conecte o repositório que contém `render.yaml`; ou crie um Web Service manualmente.
2. Se usar Blueprint, o Render lê `render.yaml` e cria `lojanumismatica` no plano Free.
3. Preencha as variáveis marcadas como `sync: false`:
   - `BASE_URL`: `https://lojanumismaticamcp.onrender.com`
   - `SUPABASE_URL`: URL do seu projeto Supabase
   - `SUPABASE_SECRET_KEY`: `sb_secret_...`
   - `WHATSAPP_NUMBER`: ex. `5596999999999`
4. `APP_ENCRYPTION_KEY` e `SETUP_TOKEN` são gerados automaticamente pelo Blueprint.
5. Faça o deploy.

Se criar o serviço manualmente:

- Runtime: **Node**
- Build command: `npm install`
- Start command: `npm start`
- Health check: `/healthz`
- Plan: **Free**
- Node: 22 ou superior

Adicione também todas as variáveis do `.env.example`.

## 5. Criar o primeiro administrador com segurança

Depois do deploy:

1. No Render, abra **Environment** e copie o valor de `SETUP_TOKEN`.
2. Abra `https://lojanumismaticamcp.onrender.com/setup`.
3. Informe o token, seu e-mail e uma senha forte.
4. A página mostrará uma chave TOTP de cerca de 32 caracteres.
5. No Google Authenticator: **+ > Inserir chave de configuração**.
   - Nome: `Loja numismática`
   - Sua chave: a chave mostrada pela página
   - Tipo: **Baseada em tempo**
6. Depois entre em `https://lojanumismaticamcp.onrender.com/login`.

Assim que o primeiro administrador é criado, `/setup` se bloqueia automaticamente. Você pode ainda remover `SETUP_TOKEN` das variáveis do Render e fazer um novo deploy.

## 6. Domínio próprio (opcional)

O endereço grátis será parecido com:

`https://lojanumismaticamcp.onrender.com`

No Render, em **Settings > Custom Domains**, você pode adicionar seu domínio. O Render fornece TLS/HTTPS gerenciado. Depois atualize `BASE_URL` para o domínio HTTPS final.

## Segurança implementada

- Argon2id para senha.
- 2FA TOTP obrigatório.
- segredo do 2FA criptografado com AES-256-GCM.
- cookie HttpOnly, Secure e SameSite=Strict em produção.
- sessões persistentes no Supabase.
- CSRF + verificação de Origin.
- rate limiting de login, pedidos e uploads.
- bloqueio após tentativas de senha incorretas.
- CSP, HSTS, anti-clickjacking e políticas de navegador.
- RLS habilitado e nenhuma permissão de acesso às tabelas para `anon`/`authenticated`.
- Secret Key usada apenas no backend.
- preços e estoque recalculados em uma função PostgreSQL transacional.
- cancelamento devolve estoque em transação.
- imagens validadas e reprocessadas para WEBP com Sharp.
- limite de 12 fotos por produto.
- uploads salvos no Supabase Storage, não no filesystem efêmero do Render.
- auditoria administrativa.
- instalação inicial de uso único via `/setup`.

## Testar localmente no Windows CMD

```cmd
copy .env.example .env
notepad .env
npm install
npm start
```

No `.env`, preencha `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `APP_ENCRYPTION_KEY` e `SETUP_TOKEN`.

Gere `APP_ENCRYPTION_KEY` e `SETUP_TOKEN` separadamente:

```cmd
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Abra `http://localhost:3000/setup` para criar o administrador.

## Backup

```cmd
npm run backup
```

O comando exporta dados das tabelas para JSON em `backups/`. As fotos ficam no Supabase Storage e devem ser exportadas separadamente quando necessário.

## Observações sobre os planos gratuitos

O Render Free pode entrar em suspensão depois de um período sem acessos e demorar para acordar na primeira visita. Isso não apaga seus dados porque banco e fotos estão no Supabase.

O plano gratuito do Supabase possui cotas. Acompanhe **Usage** no painel. Não considere plano gratuito como substituto de uma estratégia de backup para um comércio com dados importantes.

- Título principal e descrição da página inicial editáveis pelo painel administrativo.


## Editor visual do título e da descrição
No painel em Configurações, o título principal e a descrição possuem editor com negrito, itálico, sublinhado, alinhamento, tamanho de fonte, cor e limpeza de formatação. O HTML é sanitizado no servidor antes de ser armazenado e antes de ser enviado ao navegador.


## Correção para salvar peças com fotos
Se o banco foi criado com uma versão anterior e aparece `Não foi possível salvar a peça` somente quando há foto, execute uma vez no Supabase SQL Editor o arquivo `supabase/fix-save-product-images.sql`. Não apague dados e não execute o setup completo novamente.


## Administração de produtos
- Produtos ativos e desativados aparecem com status visual diferente no painel.
- É possível ativar/desativar sem excluir.
- O botão Excluir remove definitivamente produtos que nunca participaram de pedidos. Produtos presentes em pedidos antigos devem ser apenas desativados para preservar o histórico.


## Cadastro numismático genérico
Para bancos já existentes, execute uma vez `supabase/migrate-all-numismatic-products.sql` no SQL Editor do Supabase. O cadastro passa a aceitar moedas, cédulas, medalhas, fichas, tokens, jetons, vales, padrões/provas/ensaios, conjuntos, blisters, sachês/lotes e outros itens.


## Atualização de preço e cache
- O cadastro administrativo recebe preço em Reais (ex.: 150,00), convertido no servidor para centavos.
- Nome, preço e estoque são destacados como obrigatórios.
- Recursos públicos e chamadas da API usam política sem cache para evitar exibição de conteúdo antigo após atualização.


## Plataforma multi-lojas (revenda para lojas numismáticas)

O sistema atende várias lojas ao mesmo tempo. Cada loja tem catálogo, pedidos, administradores, configurações e fotos separados. O dono da plataforma gerencia as lojas e as mensalidades em `/plataforma`.

### Ativar (uma única vez, nesta ordem)
1. No Supabase > SQL Editor, execute `supabase/migrate-multi-loja.sql`. Os dados atuais viram a loja nº 1 (`principal`); nada é apagado.
2. Só depois publique o código (push no GitHub → deploy no Render).
3. Acesse `https://lojanumismaticamcp.onrender.com/plataforma/entrar`, informe o `SETUP_TOKEN` do Render e crie seu acesso com Google Authenticator.

### Endereços das lojas
- **Loja principal:** continua em `BASE_URL` (ex.: `lojanumismaticamcp.onrender.com`).
- **Subdomínios:** compre um domínio (ex.: `suaplataforma.com.br`), defina `PLATFORM_DOMAIN=suaplataforma.com.br` no Render e adicione o domínio curinga `*.suaplataforma.com.br` em Render > Settings > Custom Domains. Cada loja fica em `endereco.suaplataforma.com.br` e o painel em `painel.suaplataforma.com.br/plataforma`.
- **Domínio próprio da loja:** cadastre no campo "Domínio próprio", adicione o domínio em Render > Custom Domains e peça ao cliente para apontar o DNS conforme o Render indicar.

### Criar uma loja para um cliente
1. Em `/plataforma`, clique em **+ Nova loja**, preencha nome, endereço, dono, mensalidade e "pago até".
2. O sistema mostra um **token de instalação** (aparece uma única vez). Clique em **Copiar mensagem para o cliente** e envie.
3. O cliente acessa `endereco-da-loja/setup`, cria a senha e o 2FA, e passa a usar `/login` e `/admin` normalmente.

### Mensalidades e bloqueio automático
- **Em dia:** "pago até" no futuro.
- **Vencida (tolerância):** passou de "pago até", mas ainda dentro dos dias de tolerância — loja continua no ar.
- **Bloqueada por atraso:** passou da tolerância — site e painel da loja saem do ar até o pagamento.
- **Pagamento:** botão **Pagamento** estende "pago até" pelos meses pagos e grava o histórico.
- **Suspensa/Cancelada:** tira a loja do ar manualmente.
