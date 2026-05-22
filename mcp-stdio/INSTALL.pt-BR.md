# Instalação do bx24-template-mcp no Claude Desktop (DXT)

Guia de **instalação local** via extensão do Claude Desktop. O servidor roda na sua máquina — sem domínio público, sem Bearer token. O segredo do webhook do Bitrix24 fica no armazenamento criptografado do Claude Desktop (macOS Keychain / Windows DPAPI / Linux libsecret).

## Pré-requisitos

- Claude Desktop ≥ 0.10.0 ([baixar](https://claude.ai/download)).
- Acesso a um portal Bitrix24 com permissão para criar webhooks de entrada.
- Arquivo `bx24-template-mcp.dxt` — baixe em [GitHub Releases](https://github.com/bitrix24/templates-mcp/releases) ou compile localmente (`pnpm install && pnpm build:dxt`).

## Passos

1. **Crie um webhook de entrada no Bitrix24.**
   - Portal → **Recursos para desenvolvedores → Outros → Webhook de entrada**.
   - Permissões necessárias: `task`, `user`, `crm` (preparação futura). Em portal de teste pode marcar tudo.
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

## Problemas comuns

- Claude Desktop: **Configurações → Extensions → bx24-template-mcp → View logs** — mostra o stderr do processo.
- Erros mais frequentes:
  - `NUXT_BITRIX24_WEBHOOK_URL is not set` — o campo obrigatório do passo 3 ficou em branco.
  - `Request failed with status code 401/403` — webhook revogado ou sem permissão para o método chamado.
  - `unable to verify the first certificate` — Self-Hosted com CA interna sem `NODE_EXTRA_CA_CERTS` configurado.

Issues e dúvidas: <https://github.com/bitrix24/templates-mcp/issues>.
