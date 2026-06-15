# Instalação do bx24-template-mcp no Claude Desktop (DXT)

Guia de **instalação local** via extensão do Claude Desktop. O servidor roda na sua máquina — sem domínio público, sem Bearer token. O segredo do webhook do Bitrix24 fica no armazenamento criptografado do Claude Desktop (macOS Keychain / Windows DPAPI / Linux libsecret).

## Pré-requisitos

- Claude Desktop ≥ 0.10.0 ([baixar](https://claude.ai/download)).
- Acesso a um portal Bitrix24 com permissão para criar webhooks de entrada.
- Arquivo `bx24-template-mcp.dxt` — baixe em [GitHub Releases](https://github.com/bitrix24/templates-mcp/releases) ou compile localmente (`pnpm install && pnpm build:dxt`).

## Passos

1. **Crie um webhook de entrada no Bitrix24.**
   - Portal → **Recursos para desenvolvedores → Outros → Webhook de entrada**.
   - Permissões necessárias: `task` + `user` (mínimo para o conjunto atual de ferramentas). Em portal de teste pode marcar tudo. Estenda a lista apenas quando você adicionar ferramentas para um novo domínio (por exemplo, `crm` — só depois que ferramentas de deals/contatos/leads forem adicionadas no fork).
   - Salve e **copie a URL inteira** — algo como `https://sua-empresa.bitrix24.com.br/rest/1/abc123def456/`.

2. **Instale a extensão.**
   - Abra Claude Desktop → **Configurações → Extensions → Install from file**.
   - Arraste o `bx24-template-mcp.dxt` para a janela ou escolha pelo seletor.

3. **Preencha os parâmetros.**
   - **Bitrix24 webhook URL** — cole a URL inteira, com a barra final.
   - **GitHub feedback token** *(opcional)* — PAT fine-grained com `Issues: read/write` em `bitrix24/templates-mcp`. Deixando em branco, a ferramenta `bx24mcp_submit_feedback` fica desativada.
   - **Feedback repository** — deixe `bitrix24/templates-mcp`, a menos que tenha um fork.
   - **Log level** — `info` por padrão. Use `debug` para inspecionar as chamadas HTTP; `warning`/`error` para um log mais silencioso no dia a dia. Os logs vão para stderr (painel de logs da extensão), nunca stdout.

4. **Habilite a extensão** marcando o checkbox e teste em um chat novo: peça ao Claude — *"Mostre meu usuário atual do Bitrix24"*. Deve voltar o nome/e-mail da conta dona do webhook.

## Bitrix24 Self-Hosted (on-premise)

Suportado. A URL do webhook tem a mesma estrutura: `https://crm.empresa.com.br/rest/<user_id>/<secret>/`. Se o portal usa **certificado autoassinado ou CA interna**, o processo Node precisa confiar nele. Antes de subir o Claude Desktop:

```bash
# macOS / Linux (no shell de onde o Claude Desktop é iniciado)
export NODE_EXTRA_CA_CERTS=/caminho/para/ca-bundle.pem
```

```powershell
# Windows
[Environment]::SetEnvironmentVariable("NODE_EXTRA_CA_CERTS","C:\certs\bitrix-ca.pem","User")
```

Reinicie o Claude Desktop para a variável ser herdada pelo processo da extensão.

## LGPD, privacidade e residência de dados

- O segredo do webhook **não sai do dispositivo** — fica no keychain do SO via Claude Desktop.
- Todas as requisições saem da sua máquina direto para o seu portal Bitrix24. Não há intermediários.
- Os logs (stderr) **redatam a URL** através do `makeRedactingLogger`: mesmo que o Claude Desktop registre o log da extensão, o segredo na URL aparece como `<REDACTED>`.
- O `.dxt` descompactado fica no diretório de extensões do Claude Desktop como arquivos comuns — se for um ambiente sensível à LGPD, considere cifrar o disco (FileVault / BitLocker / LUKS).
- Nenhuma telemetria sai do projeto. As únicas chamadas externas são: (a) o seu portal Bitrix24 e (b) a API do GitHub Issues — esta última *apenas* quando o assistente decide invocar `bx24mcp_submit_feedback` E você forneceu o PAT.

## OAuth em vez de webhook (opcional)

Útil quando a empresa proíbe credenciais de serviço compartilhadas e de longa duração (SOC2, auditorias) ou quando cada chamada precisa rodar sob a identidade real do usuário, não de uma conta de serviço.

O mesmo `.dxt` oficial funciona tanto em modo webhook quanto em OAuth — o modo é escolhido pelos campos que você preenche no Claude Desktop. Nenhuma recompilação é necessária.

**O que preparar no lado do Bitrix24** (uma vez por empresa ou por usuário, à sua escolha):

1. Acesse o cabinet de parceiro Bitrix24 (ou o admin do portal): **Aplicações → Marketplace → Criar aplicação**.
2. Escolha o tipo **«aplicação sem `redirect_uri`»** (fluxo OOB — o Bitrix24 mostra o código de consentimento na própria página).
3. Após criar, você recebe **`CLIENT_ID`** e **`CLIENT_SECRET`**. Copie os dois valores, vão ser usados agora.

**Como ativar no Claude Desktop:**

1. Nas **configurações da extensão** (Settings → Extensions → bx24-template-mcp):
   - **Deixe o campo «Bitrix24 webhook URL» vazio.**
   - Preencha **«Bitrix24 portal host (OAuth only)»**: apenas o hostname do portal, sem `https://` nem barras — ex. `minhaempresa.bitrix24.com.br` ou seu domínio Self-Hosted.
   - Preencha **«Bitrix24 OAuth Client ID»** — o `CLIENT_ID` do passo 3 acima.
   - Preencha **«Bitrix24 OAuth Client Secret»** — o `CLIENT_SECRET` do passo 3 acima. O campo é `sensitive` e fica no keychain do SO (macOS Keychain / Windows DPAPI / Linux libsecret). **Caveat Linux:** em sistema headless sem GNOME Keyring / KWallet o Claude Desktop pode cair para armazenamento em arquivo de configuração em plaintext — verifique com `secret-tool` ou equivalente antes do uso em produção.
2. Ative a extensão. No log (Settings → Extensions → bx24-template-mcp → View logs) aparecerá uma linha do tipo: `Bitrix24 OAuth onboarding required. Open: https://minhaempresa.bitrix24.com.br/oauth/authorize/?client_id=...`
3. Abra a URL no navegador, faça login no seu portal e clique em «Permitir». O Bitrix24 mostra um código curto na própria página de consentimento — ele tem **TTL ~30 segundos**, copie rápido.
4. No Claude, peça ao assistente: *«conclua o setup do OAuth com o código XXXXXX»*. Ele chama a ferramenta `bx24mcp_oauth_paste_code`, e os tokens são gravados localmente em `<diretório-de-dados>/bx24-template-mcp/oauth.json` (modo 0o600).
5. A partir daí, todas as ferramentas Bitrix24 rodam sob a sua identidade pessoal e suas permissões. Se o refresh-token for revogado do lado do portal, as ferramentas retornam «re-onboarding required» — repita os passos 2-4.

**Rotação de segredo:** gere um novo `CLIENT_SECRET` no cabinet de parceiro Bitrix24, cole no campo do Claude Desktop, reinicie a extensão. Tokens antigos são invalidados automaticamente.

**Voltar para webhook:** limpe os três campos OAuth (portal host, Client ID, Client Secret) e preencha a URL do webhook. Reinicie a extensão.

**Trade-off:** o `CLIENT_SECRET` fica no keychain do SO via Claude Desktop. Não é um fluxo público com PKCE (o Bitrix24 ainda não oferece), mas também NÃO é build-time-bake — o segredo NÃO está embutido no `.dxt`. Em termos de superfície de ataque, esse segredo protege a **identidade da aplicação no Marketplace**, não os seus tokens OAuth (que são por usuário e ficam apenas no dispositivo).

## Problemas comuns

- Claude Desktop: **Configurações → Extensions → bx24-template-mcp → View logs** — mostra o stderr do processo.
- Erros mais frequentes:
  - `No Bitrix24 credentials configured` — nem o webhook nem os três campos OAuth (portal host + Client ID + Client Secret) foram preenchidos.
  - `Request failed with status code 401/403` — webhook revogado ou sem permissão para o método chamado.
  - `OAuth onboarding has not been completed yet` — modo OAuth ainda sem paste-code (veja a seção acima).
  - `OAuth refresh token has been revoked` — alguém desinstalou o app no portal; rode `bx24mcp_oauth_paste_code` de novo.
  - `unable to verify the first certificate` — Self-Hosted com CA interna sem `NODE_EXTRA_CA_CERTS` configurado.

Issues e dúvidas: <https://github.com/bitrix24/templates-mcp/issues>.
