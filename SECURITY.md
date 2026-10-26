# Segurança — Loja numismática Cloud

## Segredos

Nunca versione `.env`. `SUPABASE_SECRET_KEY`, `APP_ENCRYPTION_KEY` e `SETUP_TOKEN` são segredos de servidor.

A Secret Key do Supabase possui privilégios elevados e ignora RLS. Ela existe exclusivamente no backend. O navegador nunca recebe essa chave.

## Banco

Todas as tabelas têm RLS habilitado e privilégios removidos dos papéis públicos `anon` e `authenticated`. O backend usa Secret Key depois de aplicar sua própria autenticação/autorização.

Pedidos são criados pela função PostgreSQL `create_order`, que bloqueia produtos, verifica estoque, lê o preço armazenado no banco, desconta estoque e grava pedido/itens em uma única transação.

## Fotos

O backend aceita no máximo 3 MB por upload e 25 MP de entrada. Somente JPEG, PNG e WEBP decodificáveis são aceitos. A imagem é rotacionada, redimensionada e reencodada para WEBP antes de ir ao bucket `product-images`.

O bucket é público apenas para leitura das fotos de catálogo. Escrita ocorre com a Secret Key no backend.

## Primeiro administrador

`/setup` funciona somente enquanto `users` está vazio e exige `SETUP_TOKEN`. O segredo TOTP é devolvido somente na resposta HTTPS da criação; não é impresso nos logs do servidor.

Após configurar o primeiro administrador, remova `SETUP_TOKEN` do Render se desejar uma redução adicional da superfície de segredo.

## Rotação

Se `SUPABASE_SECRET_KEY` vazar, crie uma nova Secret Key no Supabase, atualize o Render e revogue a antiga.

Se `APP_ENCRYPTION_KEY` for perdida, os segredos TOTP criptografados existentes não poderão ser descriptografados. Guarde-a em um gerenciador de senhas seguro.
