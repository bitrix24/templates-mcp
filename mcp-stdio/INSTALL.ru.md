# Установка bx24-template-mcp в Claude Desktop (DXT)

Это инструкция для **локальной установки** через расширение Claude Desktop. Сервер запускается у вас на компьютере — никакого публичного домена, никакого Bearer-токена. Секрет вебхука Bitrix24 хранится в зашифрованном хранилище Claude Desktop (macOS Keychain / Windows DPAPI / Linux libsecret).

## Что понадобится

- Claude Desktop ≥ 0.10.0 ([скачать](https://claude.ai/download)).
- Доступ к порталу Bitrix24 с правом создавать входящие вебхуки.
- Файл `bx24-template-mcp.dxt` — берите из [GitHub Releases](https://github.com/bitrix24/templates-mcp/releases) или соберите сами (`pnpm install && pnpm build:dxt`).

## Шаги установки

1. **Создайте входящий вебхук в Bitrix24.**
   - Зайдите в портал → «Разработчикам» → «Другое» → «Входящий вебхук».
   - Разрешения, которые нужны проекту: `task` + `user` (минимум для текущего набора инструментов). Можно поставить «Все», если портал тестовый. Расширяйте список только когда добавите инструменты для нового домена (например, `crm` — только если в форке добавлены инструменты для сделок/контактов/лидов).
   - Сохраните и **скопируйте URL целиком** — он выглядит как `https://your-portal.bitrix24.ru/rest/1/abc123def456/`.

2. **Установите расширение.**
   - Откройте Claude Desktop → **Настройки → Extensions → Install from file**.
   - Перетащите `bx24-template-mcp.dxt` в окно или выберите файл вручную.

3. **Заполните параметры.**
   - **Bitrix24 webhook URL** — вставьте URL целиком, с финальным слэшем.
   - **GitHub feedback token** *(опционально)* — fine-grained PAT с правом `Issues: read/write` на `bitrix24/templates-mcp`. Если оставите пустым, инструмент `bx24mcp_submit_feedback` будет недоступен.
   - **Feedback repository** — оставьте `bitrix24/templates-mcp`, если только не делаете форк.
   - **Log level** — `info` по умолчанию. `debug` если нужно посмотреть HTTP-вызовы; `warning`/`error` — тише для повседневной работы. Логи идут в stderr (панель логов расширения), не в stdout.

4. **Включите расширение** галочкой и проверьте: в новом чате попросите Claude — *«Покажи моего текущего пользователя Bitrix24»*. Должно вернуться имя/email учётки, на которой создан вебхук.

## Bitrix24 Self-Hosted (on-premise)

Поддерживается. URL вебхука имеет ту же структуру: `https://crm.company.ru/rest/<user_id>/<secret>/`. Если портал работает с **самоподписанным сертификатом или внутренним УЦ**, Node-процесс должен ему доверять. Перед запуском Claude Desktop выставьте:

```bash
# macOS / Linux (в shell, из которого запускается Claude Desktop)
export NODE_EXTRA_CA_CERTS=/path/to/your-internal-ca-bundle.pem
```

```powershell
# Windows
[Environment]::SetEnvironmentVariable("NODE_EXTRA_CA_CERTS","C:\certs\bitrix-ca.pem","User")
```

После этого перезапустите Claude Desktop, чтобы переменная подхватилась дочерним процессом расширения.

## Безопасность и приватность

- Секрет вебхука **не покидает устройство** — хранится в системном кейчейне Claude Desktop.
- Все запросы идут с вашей машины напрямую в ваш портал Bitrix24. Третьих сторон нет.
- Логи (stderr) **редактируют URL** через `makeRedactingLogger`: даже если Claude Desktop пишет лог расширения, секрет внутри URL заменён на `<REDACTED>`.
- Распакованный `.dxt` лежит в директории расширений Claude Desktop как обычные файлы — если параноите, шифруйте раздел диска целиком (FileVault / BitLocker / LUKS).

## OAuth вместо вебхука (опционально, для подготовленных сборок)

Подойдёт, если ваша компания запрещает long-lived shared service-credentials (SOC2, аудиты) или вы хотите, чтобы каждый запрос исполнялся под реальной учёткой пользователя, а не сервисного аккаунта.

Доступно только в сборках `.dxt`, собранных с OAuth-учётками Marketplace-приложения (релиз bx24-template-mcp из Bitrix24 Marketplace или ваш форк со своим `BITRIX24_DXT_OAUTH_CLIENT_ID` / `_SECRET`). В сборке без этих учёток поле «portal host» просто игнорируется, бандл остаётся на вебхуке.

**Как включить:**

1. В Claude Desktop **оставьте поле «Bitrix24 webhook URL» пустым** и заполните поле **«Bitrix24 portal host (OAuth only)»**: только хостнейм портала, без `https://` и слэшей — например `mycompany.bitrix24.ru` или ваш Self-Hosted домен.
2. Включите расширение. В логе (Settings → Extensions → bx24-template-mcp → View logs) появится строка вида: `Bitrix24 OAuth onboarding required. Open: https://mycompany.bitrix24.ru/oauth/authorize/?client_id=...`
3. Откройте URL в браузере, залогиньтесь в свой портал и нажмите «Разрешить». Bitrix24 покажет короткий код прямо на странице согласия — у него **TTL ~30 секунд**, скопируйте быстро.
4. В Claude попросите ассистента: *«заверши настройку OAuth кодом XXXXXX»*. Он вызовет инструмент `bx24mcp_oauth_paste_code`, и токены сохранятся локально в `<директория-данных>/bx24-template-mcp/oauth.json` (права 0o600).
5. Дальше любые инструменты Bitrix24 идут под вашей личной учёткой и правами доступа. Если refresh-токен будет отозван на стороне портала — инструменты вернут «re-onboarding required», повторите шаги 2-4.

`client_secret` Marketplace-приложения зашит в бандл (Bitrix24 пока не предлагает PKCE). Это документированный trade-off OOB-потока: секрет защищает **идентичность приложения**, а не ваши токены (они персональные и живут только на устройстве).

## Если что-то пошло не так

- В Claude Desktop: **Настройки → Extensions → bx24-template-mcp → View logs** — там stderr процесса.
- Самые частые ошибки:
  - `No Bitrix24 credentials configured` — не заполнили ни вебхук, ни «portal host» (для OAuth-сборки).
  - `Request failed with status code 401/403` — вебхук отозван или не имеет прав на нужный метод.
  - `OAuth onboarding has not been completed yet` — в OAuth-режиме ещё не выполнен паст-код (см. секцию выше).
  - `OAuth refresh token has been revoked` — кто-то удалил приложение из портала; запустите `bx24mcp_oauth_paste_code` заново.
  - `unable to verify the first certificate` — Self-Hosted с внутренним УЦ, не выставлен `NODE_EXTRA_CA_CERTS`.

Issue или вопрос: <https://github.com/bitrix24/templates-mcp/issues>.
