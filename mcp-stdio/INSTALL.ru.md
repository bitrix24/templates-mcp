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

## OAuth вместо вебхука (опционально)

Подойдёт, если ваша компания запрещает long-lived shared service-credentials (SOC2, аудиты) или вы хотите, чтобы каждый запрос исполнялся под реальной учёткой пользователя, а не сервисного аккаунта.

Один и тот же официальный `.dxt`-бандл умеет работать как в webhook-режиме, так и в OAuth: режим выбирается набором заполненных полей в Claude Desktop. Никаких пересборок не нужно.

**Что подготовить со стороны Bitrix24** (один раз на всю компанию или на каждого пользователя — на ваше усмотрение):

1. Войдите в партнёрский кабинет Bitrix24 (или в админку портала): **Приложения → Marketplace → Создать приложение**.
2. Выберите тип **«приложение без `redirect_uri`»** (OOB-сценарий — Bitrix24 покажет код согласия прямо на странице). В русской UI Bitrix24 это может называться «без обратного адреса» — это та же опция.
3. После создания вы получите **`CLIENT_ID`** и **`CLIENT_SECRET`**. Скопируйте оба значения, они сейчас понадобятся.

**Как включить в Claude Desktop:**

1. В **настройках расширения** (Settings → Extensions → bx24-template-mcp):
   - **Оставьте поле «Bitrix24 webhook URL» пустым.**
   - Заполните **«Bitrix24 portal host (OAuth only)»**: только хостнейм портала, без `https://` и слэшей — например `mycompany.bitrix24.ru` или ваш Self-Hosted домен.
   - Заполните **«Bitrix24 OAuth Client ID»** — `CLIENT_ID` из шага 3 выше.
   - Заполните **«Bitrix24 OAuth Client Secret»** — `CLIENT_SECRET` из шага 3 выше. Поле помечено как `sensitive`, значение хранится в системном keychain (macOS Keychain / Windows DPAPI / Linux libsecret). **Linux caveat:** на headless-системе без GNOME Keyring / KWallet Claude Desktop может откатиться к plaintext-файлу конфига — проверьте через `secret-tool` или эквивалент перед production-использованием.
2. Включите расширение. В логе (Settings → Extensions → bx24-template-mcp → View logs) появится строка вида: `Bitrix24 OAuth onboarding required. Open: https://mycompany.bitrix24.ru/oauth/authorize/?client_id=...`
3. Откройте URL в браузере, залогиньтесь в свой портал и нажмите «Разрешить». Bitrix24 покажет короткий код прямо на странице согласия — у него **TTL ~30 секунд**, скопируйте быстро.
4. В Claude попросите ассистента: *«заверши настройку OAuth кодом XXXXXX»*. Он вызовет инструмент `bx24mcp_oauth_paste_code`, и токены сохранятся локально в `<директория-данных>/bx24-template-mcp/oauth.json` (права 0o600).
5. Дальше любые инструменты Bitrix24 идут под вашей личной учёткой и правами доступа. Если refresh-токен будет отозван на стороне портала — инструменты вернут «re-onboarding required», повторите шаги 2-4.

**Ротация секрета:** сгенерируйте новый `CLIENT_SECRET` в партнёрском кабинете Bitrix24, вставьте в поле в Claude Desktop, перезапустите расширение. Старые токены автоматически инвалидируются.

**Возврат на webhook:** очистите три OAuth-поля (portal host, Client ID, Client Secret) и заполните webhook URL. Перезапустите расширение.

**Trade-off:** `CLIENT_SECRET` хранится в системном keychain через Claude Desktop. Это не публичный PKCE-флоу (Bitrix24 его пока не предлагает), но и не build-time-bake — секрет НЕ зашит в `.dxt`. На уровне атак этот секрет защищает **идентичность Marketplace-приложения**, а не ваши OAuth-токены (они персональные и живут только на устройстве).

## Если что-то пошло не так

- В Claude Desktop: **Настройки → Extensions → bx24-template-mcp → View logs** — там stderr процесса.
- Самые частые ошибки:
  - `No Bitrix24 credentials configured` — не заполнили ни вебхук, ни OAuth-поля (portal host + Client ID + Client Secret).
  - `Request failed with status code 401/403` — вебхук отозван или не имеет прав на нужный метод.
  - `OAuth onboarding has not been completed yet` — в OAuth-режиме ещё не выполнен паст-код (см. секцию выше).
  - `OAuth refresh token has been revoked` — кто-то удалил приложение из портала; запустите `bx24mcp_oauth_paste_code` заново.
  - `unable to verify the first certificate` — Self-Hosted с внутренним УЦ, не выставлен `NODE_EXTRA_CA_CERTS`.

Issue или вопрос: <https://github.com/bitrix24/templates-mcp/issues>.
