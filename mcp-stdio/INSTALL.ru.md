# Установка bx24-template-mcp в Claude Desktop (DXT)

Это инструкция для **локальной установки** через расширение Claude Desktop. Сервер запускается у вас на компьютере — никакого публичного домена, никакого Bearer-токена. Секрет вебхука Bitrix24 хранится в зашифрованном хранилище Claude Desktop (macOS Keychain / Windows DPAPI / Linux libsecret).

## Что понадобится

- Claude Desktop ≥ 0.10.0 ([скачать](https://claude.ai/download)).
- Доступ к порталу Bitrix24 с правом создавать входящие вебхуки.
- Файл `bx24-template-mcp.dxt` — берите из [GitHub Releases](https://github.com/bitrix24/templates-mcp/releases) или соберите сами (`pnpm install && pnpm build:dxt`).

## Шаги установки

1. **Создайте входящий вебхук в Bitrix24.**
   - Зайдите в портал → «Разработчикам» → «Другое» → «Входящий вебхук».
   - Разрешения, которые нужны проекту: `task`, `user`, `crm` (на будущее). Можно поставить «Все», если портал тестовый.
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

## Если что-то пошло не так

- В Claude Desktop: **Настройки → Extensions → bx24-template-mcp → View logs** — там stderr процесса.
- Самые частые ошибки:
  - `NUXT_BITRIX24_WEBHOOK_URL is not set` — не заполнили обязательное поле в шаге 3.
  - `Request failed with status code 401/403` — вебхук отозван или не имеет прав на нужный метод.
  - `unable to verify the first certificate` — Self-Hosted с внутренним УЦ, не выставлен `NODE_EXTRA_CA_CERTS`.

Issue или вопрос: <https://github.com/bitrix24/templates-mcp/issues>.
