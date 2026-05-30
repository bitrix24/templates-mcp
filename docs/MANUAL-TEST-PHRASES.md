# Manual test phrases for the Bitrix24 MCP

`Last reviewed: 2026-05-30`

This is the operator's natural-language test pack for the MCP. Paste each phrase into Claude (or any MCP-connected LLM) with the connector enabled and observe:

1. **Which tool(s) does the LLM call?**
2. **What arguments does it pass?**
3. **Is the result what you'd expect?**

The point is to see how a real LLM **disambiguates phrasing** — not to assert exact outputs. Phrasings deliberately vary in formality, completeness, and language (Russian / English) so we can spot tool-description gaps and prompt-engineering needs.

## REST API version notes

Bitrix24 has two parallel REST API generations:

- **v3** (modern, recommended) — methods under the `tasks.*` namespace. URL pattern `apidocs.bitrix24.com/api-reference/rest-v3/…`.
- **v2** (legacy / deprecated for new development) — methods like `task.*` (without the `s.`), `task.item.*`. Still work, but docs flag them with "Метод устарел".

**Default to v2 (per `SKILL.md` rule #7); v3 only for v3-only methods.** Our coverage today (29 Bitrix24 tools + 1 meta-tool):

| Tool | Method | Transport |
|---|---|---|
| `b24_user_me` | `user.current` | v2 (no v3 equivalent — user identity predates v3) |
| `b24_user_find` | `user.search` | v2 (same reason as above) |
| `b24_task_create` | `tasks.task.add` | v2 (classic method routed through `callV2` per PR #105) |
| `b24_task_list` | `tasks.task.list` | v2 (classic; rest-v3 returns "restApi:v3 not support method tasks.task.list") |
| `b24_task_update` | `tasks.task.update` | v2 (classic) |
| `b24_task_comment_add` | `task.commentitem.add` | v2 (deprecated — v3 replacement `tasks.task.chat.message.send` queued, no issue filed yet) |
| `b24_task_start` | `tasks.task.start` | v2 (classic) |
| `b24_task_pause` | `tasks.task.pause` | v2 (classic) |
| `b24_task_complete` | `tasks.task.complete` | v2 (classic) |
| `b24_task_approve` | `tasks.task.approve` | v2 (classic) |
| `b24_task_disapprove` | `tasks.task.disapprove` | v2 (classic) |
| `b24_task_defer` | `tasks.task.defer` | v2 (classic) |
| `b24_task_renew` | `tasks.task.renew` | v2 (classic) |
| `b24_task_rate` | `tasks.task.update` (field `MARK`) | v2 — no dedicated rate method; we write `MARK: "P" \| "N" \| null` |
| `b24_task_checklist_item_add` | `task.checklistitem.add` | v2 only — v3 `tasks.template.checklist.*` is for templates, not task instances |
| `b24_task_checklist_item_list` | `task.checklistitem.getlist` | v2 only (same reason) |
| `b24_task_checklist_item_complete` | `task.checklistitem.complete` | v2 only (same reason) |
| `b24_task_checklist_item_renew` | `task.checklistitem.renew` | v2 only (same reason) |
| `b24_task_checklist_item_delete` | `task.checklistitem.delete` | v2 only (same reason) |
| `b24_task_result_add` | `tasks.task.result.add` | **v3** ✓ (v3-only method) |
| `b24_task_result_list` | `tasks.task.result.list` | **v3** ✓ — taskId filter required; baked into the schema |
| `b24_task_result_update` | `tasks.task.result.update` | **v3** ✓ — author-only |
| `b24_task_result_delete` | `tasks.task.result.delete` | **v3** ✓ — author-only; destructive |
| `b24_task_elapsed_time_add` | `task.elapseditem.add` | v2 only (no v3 equivalent for task time tracking) |
| `b24_task_elapsed_time_list` | `task.elapseditem.getlist` | v2 only (same reason) |
| `b24_task_elapsed_time_update` | `task.elapseditem.update` | v2 only — author-or-admin |
| `b24_task_elapsed_time_delete` | `task.elapseditem.delete` | v2 only — author-or-admin; destructive (`confirmDelete: true`) |
| `b24_task_dependency_add` | `task.dependence.add` | v2 only (no v3 equivalent; read-back via `getdependson` is deprecated upstream — see issue #33) |
| `b24_task_dependency_remove` | `task.dependence.delete` | v2 only — destructive (`confirmDelete: true`) |
| `bx24mcp_submit_feedback` | _(no Bitrix24 call)_ | meta-tool — files a GitHub issue |

All 8 task-mutating tools (`start` / `pause` / `complete` / `approve` / `disapprove` / `defer` / `renew` / `rate`) also accept `taskId: number[]` for batch mode (up to 25; `force: true` overrides). Batches go through the `batchV2` helper as one HTTP round-trip. The 3 checklist actions (`b24_task_checklist_item_complete` / `b24_task_checklist_item_renew` / `b24_task_checklist_item_delete`) likewise accept `itemId: number[]` for batch mode (up to 50; `force: true` overrides) and also go through `batchV2` as one round-trip.

When you see a Bitrix24 method name in a tool's source, sanity-check it has the `tasks.` (with `s`) prefix or lives under a documented v3 URL. The phrase pack below assumes v3 throughout.

## Legend

| Mark | Meaning |
|---|---|
| ✅ | Tool exists today — see the API version table above for which PR introduced each tool group. Expect the LLM to call the right tool. |
| ⏳ | Tool **does not exist yet** — queued for a future PR. Expect the LLM to either fail gracefully or suggest a workaround. Track these as "wishlist hits". |
| 🧠 | **Composite query** — no single tool covers it. The LLM should chain existing tools (list + get + reason). Watch for hallucinated tool names. |

Setup: real Bitrix24 portal webhook in `.env`, connector wired to a chat. For each section, start a fresh conversation to avoid LLM carry-over from prior turns.

---

## 1. Resolving people by name — the key UX rule

**Operators talk in names, not numeric ids.** A phrase like "create a task for user 5" is bad UX even though it's technically valid — real operators say "for Igor". The correct chain is:

1. Operator says a name.
2. LLM calls `b24_user_find { query: "<name>" }` (or structured `firstName`/`secondName`/`lastName`/`position`).
3. **One match** → use that id, proceed silently.
4. **Many matches** → ask the operator to clarify, in this order: **patronymic (отчество)** if Russian-style, then **lastName**, then **position** / **department**. **Never** ask for a numeric id unless natural-language disambiguation fails entirely.
5. **No match** → ask the operator for a fuller name, patronymic, or surname.

Patronymic priority is deliberate: in Russian business culture an "Игорь Сергеевич" identifies the person more naturally than "Игорь с id 12" or even "Игорь Шевченко". The `b24_user_find` tool returns `secondName` (Bitrix24 `SECOND_NAME`) for exactly this reason.

The phrases in section 2 are written with this rule in mind. The LLM's response should chain `b24_user_find` → confirm → `b24_task_create` invisibly when there's a clean match, and surface a disambiguation question only when needed.

| # | Phrase | What we want to see |
|---|---|---|
| 1.1 | Кто такой Игорь? | `find_user { query: "Игорь" }` → if 1 match, report id + last name + position; if many, list them compactly. |
| 1.2 | Найди бэкенд-разработчиков. | `find_user { position: "backend" }` (or `query: "backend"`). |
| 1.3 | Сколько Иванов работает у нас? | `find_user { query: "Иван", limit: 50 }` → narrate count. |
| 1.4 | Поищи в отделе 7. | LLM falls back to `find_user { query: ... }` and notes the department filter isn't supported by the current tool (department-id filter is in `user.search` but we don't expose it yet — flag as wishlist). |
| 1.5 | Игорь это который тестировщик. | LLM should use `find_user { firstName: "Игорь", position: "тестировщик" }`. |
| 1.6 | Поручи задачу Игорю Сергеевичу. | LLM should use `find_user { firstName: "Игорь", secondName: "Сергеевич" }` — patronymic is the natural Russian disambiguator before lastName. |
| 1.7 | Игорь Алексеевич Шевченко — что он делает? | `find_user { query: "Игорь Алексеевич Шевченко" }` (free-text covers all three name parts), or structured `{ firstName, secondName, lastName }`. |
| 1.8 | Найди Сергеевну в бухгалтерии. | `find_user { secondName: "Сергеевна", position: "бухгалтер" }` — feminine patronymic. |

**Negative:**
- 1.9 — Покажи всех. → `b24_user_find` with no filter returns the guidance message ("Provide at least one of: …"). LLM should ask for any narrowing input.

## 2. Basic task creation ✅ (name-resolved)

| # | Phrase | What we want to see |
|---|---|---|
| 2.1 | Создай задачу «Согласовать договор» и назначь на меня, дедлайн пятница 18:00. | `b24_user_me` → `create_task { title, responsibleId: me, deadline }`. No `b24_user_find` needed — operator referenced themselves. |
| 2.2 | Заведи задачу "Review Q2 report" для Игоря, приоритет высокий, дедлайн через 3 дня. | `find_user { query: "Игорь" }` → if 1 match, `create_task { title, responsibleId: <resolved>, priority: "2", deadline: <iso> }`. **If multiple Igors**, the LLM should ask "Игорь Шевченко, Игорь Петров — кто из них?" |
| 2.3 | Срочная задача Ивану из бэкенда: позвонить клиенту. | `find_user { firstName: "Иван", position: "backend" }` → exact match → `b24_task_create` with `priority: "2"`. |
| 2.4 | Поставь задачу Игорю Шевченко проверить логи прода. Без дедлайна, просто "когда руки дойдут". | `find_user { firstName: "Игорь", lastName: "Шевченко" }` → 1 match → `b24_task_create` with `title`, NO `deadline`. |
| 2.4.1 | Поручи Игорю Сергеевичу написать changelog к релизу 0.2.0. | `find_user { firstName: "Игорь", secondName: "Сергеевич" }` — patronymic-first disambiguation. → `b24_task_create`. |
| 2.5 | Назначь задачу группе разработки (groupId 7): «Обновить зависимости». Соисполнители Маша и Иван, наблюдатель — тимлид. | Multi-`b24_user_find` (Маша / Иван / "тимлид"), then `b24_task_create` with `groupId: 7`, `accomplices`, `auditors`. **Likely failure cases to probe:** how does the LLM handle "тимлид" (a role, not a name)? It might `find_user { position: "team lead" }` or ask for clarification. |
| 2.6 | Создай задачу с длинным описанием в BBCode для Игоря: заголовок "Спецификация API", деталь — список из 5 пунктов. | `b24_user_find` → `b24_task_create` with multi-paragraph `description` containing `[*]`/`[LIST]` BBCode. |

**Failure / clarification cases:**
- 2.7 — Создай задачу. *(Empty)* → Zod rejects missing `title`; LLM asks for clarification.
- 2.8 — Создай задачу "X". *(No responsible)* → LLM should ask for the assignee (name, not id).
- 2.9 — Создай задачу Игорю. *(2 Igors on the portal)* → LLM should reply with the list of Igors and ask which one, **by last name**, not by id.
- 2.10 — Создай задачу пользователю с id 5. → Explicit id should still work — the tool accepts `responsibleId`. But the LLM should note this is unusual phrasing.

---

## 3. Listing & finding tasks ✅

| # | Phrase | What we want to see |
|---|---|---|
| 3.1 | Покажи мои задачи. | `b24_user_me` → `list_tasks { filter: { RESPONSIBLE_ID: me } }` |
| 3.2 | Show my overdue tasks. | `list_tasks { filter: { RESPONSIBLE_ID: me, "<DEADLINE": <today-iso>, "!STATUS": 5 } }` |
| 3.3 | Покажи активные задачи Ивана. | `find_user { query: "Иван" }` → if 1 match, `list_tasks { filter: { RESPONSIBLE_ID: <resolved>, "!STATUS": [5,6,7] } }`. If many Ivans, ask for the last name first. |
| 3.4 | Все задачи группы 7, отсортированные по дедлайну. | `list_tasks { filter: { GROUP_ID: 7 }, order: { DEADLINE: "asc" } }` |
| 3.5 | Найди задачи со словом "договор" в названии. | `list_tasks { filter: { "%TITLE": "договор" } }` — `%` prefix is the LIKE operator in Bitrix24 |
| 3.6 | Сколько у меня задач без дедлайна? | `list_tasks { filter: { RESPONSIBLE_ID: me, "DEADLINE": null }, select: ["ID"] }`, returns `total` |
| 3.7 | Дай мне последние 10 закрытых задач Марии. | `find_user { query: "Мария" }` → resolve, then `list_tasks { filter: { RESPONSIBLE_ID: <resolved>, STATUS: 5 }, order: { CLOSED_DATE: "desc" } }`. Bitrix returns 50/page; LLM should slice to 10 itself. |
| 3.8 | Поставленные мной задачи на этой неделе. | `list_tasks { filter: { CREATED_BY: me, ">=CREATED_DATE": <monday-iso> } }` |

**Probe behaviour:**
- 3.9 — Покажи задачи. *(No filter)* — LLM should call `b24_task_list` and clarify after the dump if the user wanted a filter.
- 3.10 — Сколько у нас всего задач? — `list_tasks { select: ["ID"] }` → read `total`. Easy miss: LLM tries `count` which doesn't exist.

---

## 4. Updating fields ✅

| # | Phrase | What we want to see |
|---|---|---|
| 4.1 | Перенеси дедлайн задачи 123 на понедельник. | `update_task { taskId: 123, fields: { DEADLINE: <next-monday-iso> } }` |
| 4.2 | Reassign task 123 to Maria. | `find_user { query: "Maria" }` → resolve → `update_task { taskId: 123, fields: { RESPONSIBLE_ID: <resolved> } }`. |
| 4.3 | Переименуй задачу 123 в "Согласовать спецификацию API". | `update_task { taskId: 123, fields: { TITLE: "..." } }` |
| 4.4 | Снизь приоритет задачи 123 до низкого. | `update_task { taskId: 123, fields: { PRIORITY: "0" } }` |
| 4.5 | Добавь к задаче 123 ещё двух наблюдателей: 3 и 7. | LLM needs to GET current `AUDITORS` first, then `update_task { fields: { AUDITORS: [...existing, 3, 7] } }`. **Likely failure today** — no `get_task` tool, would need to use `b24_task_list` with `ID` filter and `select: ["AUDITORS"]`. |
| 4.6 | Move task 123 to workgroup 7. | `update_task { taskId: 123, fields: { GROUP_ID: 7 } }` |

**Probe behaviour:**
- 4.7 — Обнови задачу 123. *(No fields)* — Zod refine should reject empty `fields`.
- 4.8 — Перенеси задачу 123 на завтра в 11. — LLM must compute "tomorrow at 11 in the user's timezone" → ISO 8601. Time-zone hallucinations are common.

---

## 5. Adding comments ✅

| # | Phrase | What we want to see |
|---|---|---|
| 5.1 | Прокомментируй задачу 123: «Согласовано, запускаем». | `add_task_comment { taskId: 123, text: "Согласовано, запускаем" }` |
| 5.2 | Add a comment to task 123 with BBCode: link to https://example.com labelled "spec". | `b24_task_comment_add` with `text: "[URL=https://example.com]spec[/URL]"` |
| 5.3 | Напиши под задачей 123: «Ждём ответа от заказчика», и от имени пользователя 47. | `add_task_comment { taskId: 123, text: "...", authorId: 47 }` (may fail with permission error on non-admin webhooks — expected) |

---

## 6. Reading comments ⏳ — NEEDS NEW TOOL

**Status:** no tool today. Bitrix24 REST: `tasks.task.chat.message.list` (new, preferred) or `task.commentitem.getlist` (deprecated but works on classic task card).

| # | Phrase | What we want to see |
|---|---|---|
| 6.1 | Покажи последние 10 комментариев к задаче 123. | ⏳ `list_task_comments { taskId: 123, limit: 10, order: "desc" }` |
| 6.2 | Read the latest comments on task 123, skip the service messages about renames and time changes. | ⏳ Same + filter out `messageType: "SERVICE"` / `AUTHOR_ID: 0` (system author) |
| 6.3 | Что писали в задаче 123 на этой неделе? | ⏳ `list_task_comments { taskId: 123, ">=postDate": <monday> }` |
| 6.4 | Кто последним прокомментировал задачу 123? | ⏳ `list_task_comments { taskId: 123, limit: 1, order: "desc" }` → read `authorId` |

**Filtering service messages** is essential — Bitrix24 tracks every field change as a system comment ("user X changed title from … to …", "user Y added Z hours"). A read-comments tool that doesn't filter these is noise. The new tool should expose a `includeSystem: boolean` (default `false`).

---

## 7. Checklists ✅ (PR for Phase 2)

**Status:** five tools shipped. Bitrix24 REST: `task.checklistitem.{add,getlist,complete,renew,delete}` — v2 namespace; v3 has no equivalent for task checklists (only `tasks.template.checklist.*` for task templates). The whole checklist tree on a task is FLAT — every item carries a `parentId`; the special value `0` marks a **checklist heading**, and every regular item references its heading (or a deeper parent) by id. Multiple headings per task → multiple checklists.

| # | Phrase | What we want to see |
|---|---|---|
| 7.1 | Добавь чек-лист "QA" к задаче 123 с пунктами: «UI», «API», «миграция». | Four `b24_task_checklist_item_add` calls. First: `{ taskId: 123, title: "QA" }` (no `parentId` → starts a new checklist; the returned id is the heading id). Next three: `{ taskId: 123, title: "UI", parentId: <heading-id> }` etc. |
| 7.2 | Поставь в чек-листе задачи 123 пункт "QA / API" как выполненный. | `list_checklist_items { taskId: 123 }` → find the item by title → `complete_checklist_item { taskId: 123, itemId: <found> }` |
| 7.3 | Покажи прогресс чек-листа задачи 123. | `list_checklist_items { taskId: 123 }` — agent counts `isComplete: true` over the items in each heading. |
| 7.4 | Добавь в чек-лист задачи 123 ещё один пункт «деплой». | `b24_task_checklist_item_list` to locate the heading (or accept the operator naming it), then `add_checklist_item { taskId: 123, title: "деплой", parentId: <heading-id> }`. |
| 7.5 | Сними отметку выполнения с пункта «деплой» в задаче 123. | `b24_task_checklist_item_list` → match title → `renew_checklist_item { taskId: 123, itemId: <found> }`. |
| 7.6 | Удали из чек-листа задачи 123 пункт «UI». | `b24_task_checklist_item_list` → match → `delete_checklist_item { taskId: 123, itemId: <found> }`. |
| 7.7 | Создай в задаче 123 новый чек-лист "Релизный план" с пунктами: «changelog», «прогон тестов», «тег», «smoke». | Heading add (no `parentId`) + four child adds with the returned heading id. |
| 7.8 | Закрой пункты 47, 48 и 49 в задаче 123 одним вызовом. | `complete_checklist_item { taskId: 123, itemId: [47, 48, 49] }` — batch mode mirrors the lifecycle tools, returns `{ batch, total, ok, failed, results }`. |

**Tools shipped:**
- `b24_task_checklist_item_add` — `{ taskId, title, parentId?, sortIndex?, isImportant? }`. `parentId: 0` (or omitted) creates a new checklist; the `title` becomes the heading.
- `b24_task_checklist_item_list` — `{ taskId, order? }` (order: `{ field, direction }`, sort fields per apidocs).
- `b24_task_checklist_item_complete` — `{ taskId, itemId | itemId[] }` (single or batch up to 50).
- `b24_task_checklist_item_renew` — `{ taskId, itemId | itemId[] }`.
- `b24_task_checklist_item_delete` — `{ taskId, itemId | itemId[] }`. Heading deletion removes the whole checklist (heading + children) — confirm with the operator before deleting a heading.

**Out of scope this PR (file as follow-ups if real demand emerges):**
- `update_checklist_item` (move / rename / reassign members). The five tools above cover every phrase in this section; rename + move are rarely demanded and would expand the surface for marginal value.
- `MEMBERS` field on `b24_task_checklist_item_add`. The Bitrix24 API accepts `MEMBERS: { <userId>: { TYPE: "A"|"U" } }` for per-item assignees / watchers, but no test phrase exercises it today.

---

## 8. Lifecycle (start / pause / complete / approve / disapprove / defer / renew) ✅ (PR #5)

**Status:** seven thin v3 wrappers shipped. REST: `tasks.task.{start,pause,complete,approve,disapprove,defer,renew}`. Each takes `{ taskId }` (or `taskId: number[]` for batch mode up to 25, `force: true` to override) and returns the resulting status.

| # | Phrase | What we want to see |
|---|---|---|
| 8.1 | Я взялся за задачу 123. | `start_task { taskId: 123 }` |
| 8.2 | Пауза в задаче 123, отвлекли. | `pause_task { taskId: 123 }` |
| 8.3 | Закрой задачу 123, я её сделал. | `complete_task { taskId: 123 }` |
| 8.4 | Прими работу по задаче 123. | `approve_task { taskId: 123 }` |
| 8.5 | Отправь задачу 123 на доработку, исполнитель сделал не то. | `disapprove_task { taskId: 123 }` |
| 8.6 | Отложи задачу 123, пока без приоритета. | `defer_task { taskId: 123 }` |
| 8.7 | Восстанови задачу 123 из закрытых. | `renew_task { taskId: 123 }` |
| 8.8 | Start working on task 123 and add a comment "поехали". | Chain: `b24_task_start` then `b24_task_comment_add` |
| 8.9 | Закрой задачи 5, 7 и 12 одним вызовом. | `complete_task { taskId: [5, 7, 12] }` — batch mode via the `batchV2` helper, returns `{ batch, total, ok, failed, results }`. |

Trade-off recorded for the future: seven separate tools (one per verb) rather than one `b24_task_status_change` with an enum, so the LLM gets per-action description text. Tracked as `rfc(evals): measure cost — N specialized lifecycle tools vs 1 enum-based tool` in issue #9.

**Out of scope / queued for later PRs:**
- `accept` / `decline` / `delegate` — third-leg lifecycle actions not in `tasks.task.*`. Tracked in issue #8.
- `b24_task_find` for free-text task resolution — tracked in issue #6.

---

## 9. Time tracking ⏳ — NEEDS NEW TOOLS

**Status:** no tools today. REST: `task.elapseditem.{add,getlist,update,delete,get}`.

| # | Phrase | What we want to see |
|---|---|---|
| 9.1 | Запиши в задачу 123 два часа потраченных на ревью кода. | ⏳ `add_elapsed_time { taskId: 123, seconds: 7200, comment: "ревью кода" }` |
| 9.2 | Log 45 minutes against task 123 — debugging the lockfile mismatch. | ⏳ `add_elapsed_time { taskId: 123, seconds: 2700, comment: "..." }` |
| 9.3 | Сколько в сумме потрачено на задачу 123? | ⏳ `list_elapsed_time { taskId: 123 }` + agent sums `SECONDS` |
| 9.4 | Покажи логи времени по задаче 123 с описаниями. | ⏳ `list_elapsed_time { taskId: 123 }` |

**Proposed tools:**
- `b24_task_elapsed_time_add` — `{ taskId, seconds, comment?, userId? }`
- `b24_task_elapsed_time_list` — `{ taskId }`

---

## 10. Subtasks ⏳ — partial support today

**Status:** Subtasks **are** just regular tasks with `PARENT_ID` set — `b24_task_create` supports this **if** we surface the field. Currently our schema doesn't accept `parentId`. **One-line fix** in the next PR.

| # | Phrase | What we want to see |
|---|---|---|
| 10.1 | Создай подзадачу к 123: «Согласовать договор с юристами». | ⏳ `create_task { title: "...", responsibleId: …, parentId: 123 }` — needs `parentId` added to `b24_task_create` schema |
| 10.2 | Покажи подзадачи задачи 123. | ⏳ `list_tasks { filter: { PARENT_ID: 123 } }` — works today, just needs description hint |
| 10.3 | Разбей задачу 123 на 3 подзадачи: дизайн, реализация, тесты. | ⏳ Three `b24_task_create` calls with the same `parentId: 123` |

**Proposed change:** extend `b24_task_create` input with optional `parentId`. No new tool — just a schema bump. `b24_task_list` already supports `PARENT_ID` filter via the generic filter object.

---

## 11. Task linking (dependencies / related) ⏳ — partial (add/remove ✅, read ❌)

**Status:** partial. Write tools (`b24_task_dependency_add`, `b24_task_dependency_remove`) shipped in PR #35 over `tasks.task.dependence.*`. The read tool was removed in PR #43 — Bitrix24 silently decommissioned the only documented read endpoint (`task.item.getdependson`); see row 11.3 and issue #33. "Related" / "similar" is **not** a Bitrix24 concept — it's a search.

| # | Phrase | What we want to see |
|---|---|---|
| 11.1 | Свяжи задачу 123 с задачей 89, 123 зависит от 89. | ⏳ `add_task_dependency { taskId: 123, dependsOnId: 89 }` |
| 11.2 | Найди задачи похожие на 123 по названию и тегам. | 🧠 `b24_task_list` with `%TITLE` filter using keywords extracted from 123's title; agent does the matching |
| 11.3 | Список зависимостей задачи 123 — от чего она зависит. | ❌ No tool — Bitrix24 deprecated `task.item.getdependson` server-side with no v3 replacement (#33 live-smoke confirmed). Agent must direct the operator to the Bitrix24 UI. |

**Proposed tools:**
- `b24_task_dependency_add` — `{ taskId, dependsOnId }`
- `b24_task_dependency_remove` — `{ taskId, dependsOnId }`
- "Similar tasks" stays a composite query (no tool); the LLM extracts keywords and uses `b24_task_list` with `%TITLE` filter.

---

## 12. Analytics / synthesis 🧠 — NO new tools, watch the composition

These phrases are about how the LLM **uses** the tools. No new endpoints — pure orchestration. The right behaviour for each is a sequence of existing tool calls plus LLM reasoning.

| # | Phrase | Expected composition |
|---|---|---|
| 12.1 | Опиши состояние задачи 123 и её подзадач первого уровня. | `list_tasks { filter: { ID: 123 } }` (or `get_task` once added) → `list_tasks { filter: { PARENT_ID: 123 } }` → list checklist (⏳) → list recent comments (⏳) → narrative summary |
| 12.2 | Какие трудозатраты по задаче 123? | `b24_task_elapsed_time_list` (⏳) → sum, group by user/comment → narrative |
| 12.3 | Найди 5 похожих задач по теме «миграция БД» и расскажи как их решали. | `list_tasks { filter: { "%TITLE": "миграция", "STATUS": 5 } }` (closed only), take top 5 by `CLOSED_DATE desc` → for each: `list_comments` (⏳) and read `RESULT` if available → narrative |
| 12.4 | Проанализируй задачу 123 и подзадачи 1-го уровня — дай рекомендации. | All of 11.1 → LLM reasoning about completeness, blockers, time over-run, comment patterns |
| 12.5 | Что сейчас в работе у команды (group 7)? Кто чем занят? | `list_tasks { filter: { GROUP_ID: 7, STATUS: [2,3] } }` → group by `RESPONSIBLE_ID` → narrative |
| 12.6 | По задаче 123 — что обсуждалось в комментариях, без служебных? | `list_task_comments { taskId: 123, includeSystem: false }` (⏳) → summarise |
| 12.7 | Покажи "застрявшие" задачи — без активности > 7 дней, статус «в работе». | `list_tasks { filter: { STATUS: 3, "<ACTIVITY_DATE": <today-7d> } }` |

These composite queries are the **real test of the description quality** — the LLM has to figure out a multi-step plan without a tool named "describe-state".

---

## 12b. Task results ✅

**Status:** four v3 tools shipped — `b24_task_result_add`, `b24_task_result_list`, `b24_task_result_update`, `b24_task_result_delete`. A Bitrix24 task **result** is free-form text capturing what was actually delivered, kept separately from comments and from the task body. Multiple results per task allowed.

| # | Phrase | What we want to see |
|---|---|---|
| 12b.1 | Запиши результат к задаче 51: «работы выполнены, договор подписан». | `add_task_result { taskId: 51, text: "..." }` |
| 12b.2 | Add a result to task 12: shipped to production at 18:00, all checks green. | `add_task_result { taskId: 12, text: "..." }` — EN phrasing, must NOT route to add_task_comment. |
| 12b.3 | Покажи результаты задачи 51. | `list_task_results { taskId: 51 }` — default order newest-first. |
| 12b.4 | Что записано как итог работы по задаче 51? | `list_task_results { taskId: 51 }` — RU synonym ("итог") for "result". |
| 12b.5 | Покажи последний результат задачи 51. | `list_task_results { taskId: 51, limit: 1 }` — LLM should set limit. |
| 12b.6 | Поправь результат 17 — там опечатка, замени на «договор согласован 30.04». | `update_task_result { resultId: 17, text: "..." }` — resultId, NOT taskId. |
| 12b.7 | Удали результат 17 в задаче 51 — я ошибся, не должен был его записывать. | `delete_task_result { resultId: 17 }` |
| 12b.8 | Сколько результатов записано по задаче 51? | `list_task_results { taskId: 51 }` → LLM counts items. |

**Probe behaviour:**
- 12b.9 — Перезапиши результат задачи 51. *(no resultId, only parent task)* → LLM should call `list_task_results { taskId: 51 }` first, pick the latest, then `b24_task_result_update`.
- 12b.10 — Сделай результат задачи 51 более кратким. *(needs the current text)* → list first, then update with rewritten text.
- 12b.11 — Удали все результаты задачи 51. *(no batch tool)* → LLM should list + iterate `b24_task_result_delete`. Single-call batch on these v3 endpoints is not exposed today (filed under "follow-up: batch on task-result delete" if a real use case appears).

**Author-only ops:** `b24_task_result_update` and `b24_task_result_delete` are restricted to the result author (or a portal admin) by Bitrix24. Other operators hit `BITRIX_REST_V3_EXCEPTION_ACCESSDENIEDEXCEPTION`. The descriptions warn about this so the LLM doesn't waste a call.

**Out of scope (filed as follow-up candidates if real demand):**
- `tasks.task.result.addFromComment` / `.deleteFromComment` — promote a comment to a result. Depends on a comments-list tool that's queued separately (gap-analysis row 1).
- `tasks.task.result.addfromchatmessage` — needs the chat-message-send tool's response shape (still on the `task.commentitem.add` → `tasks.task.chat.message.send` migration roadmap).

---

## 13. Negative / fuzz phrases — for any section

Useful to see how robust the LLM and our error messages are.

| # | Phrase | What we want to see |
|---|---|---|
| 13.1 | Удали задачу 123. | LLM should report no `delete_task` tool exists; suggest closing instead (or queue it as future work) |
| 13.2 | Покажи задачу 999999999. | `list_tasks { filter: { ID: 999999999 } }` returns empty; LLM should report "no task found" |
| 13.3 | Создай задачу с заголовком из 1000 символов. | Zod truncates / rejects at 255 — LLM should retry or surface the error |
| 13.4 | Назначь задачу 123 несуществующему пользователю 99999. | Bitrix24 returns ERROR_CORE; our `Bitrix24ToolError` wraps it; LLM should explain |
| 13.5 | Прокомментируй задачу 123 пустым сообщением. | Zod `.min(1)` should reject |
| 13.6 | Создай задачу. Тестовая нагрузка. | Empty `title` after parse — Zod rejects |

---

## Gap analysis — tools to add (suggested next PRs)

Roughly in order of value-for-effort:

| Priority | PR scope | Tools |
|---|---|---|
| ✅ | **`feat(tools): task lifecycle`** (PR #5) | `b24_task_start`, `b24_task_pause`, `b24_task_complete`, `b24_task_approve`, `b24_task_disapprove`, `b24_task_defer`, `b24_task_renew` (7 thin wrappers) |
| ✅ | **`feat(tools): task checklist`** (PR #17) | `b24_task_checklist_item_add`, `b24_task_checklist_item_list`, `b24_task_checklist_item_complete`, `b24_task_checklist_item_renew`, `b24_task_checklist_item_delete` |
| 1 | **`feat(tools): list task comments + subtask parentId`** | `list_task_comments` (new tool, filters service messages by default); schema bump on `b24_task_create` to accept `parentId` |
| 2 | **`feat(tools): task time tracking`** | `b24_task_elapsed_time_add`, `b24_task_elapsed_time_list` |
| 3 | **`feat(tools): task dependencies`** | `b24_task_dependency_add`, `b24_task_dependency_remove` (read-back removed — see #33 / row 11.3) |
| 4 | **(retire `task.commentitem.add` → `tasks.task.chat.message.send`)** | Migrate `b24_task_comment_add` to the modern endpoint; this also fixes "deprecated" warning |

After all of those land, sections 5–10 of this doc flip from ⏳ to ✅ and the analytics queries in section 11 become realistic.

---

## 14. Multilingual phrases — i18n probe

Bitrix24 is sold in 20 locales (per `B24LangList` in `@bitrix24/b24jssdk`). The MCP must work for all of them — agents will receive prompts in the operator's language. This section is the i18n probe.

What we're verifying:

1. **Unicode end-to-end** — title / description / comment text containing non-Latin scripts arrives at Bitrix24 unchanged (no `?` substitution, no double-encoding).
2. **Numeric extraction** — the LLM can pull `responsibleId: 5` out of a sentence that's otherwise in Thai, Arabic, or Devanagari.
3. **RTL handling** — Arabic test phrases mix RTL Arabic with LTR digits and English brand names. The Bitrix24 UI must render the title correctly.
4. **CJK width** — Chinese / Japanese characters count as 1 in `string.length` but render wider in the UI. Our 255-char `title` cap is byte-agnostic, so a CJK title of 100 characters still fits.

### Locale matrix (from `B24LangList`)

| code | locale | script | sample bitrix24 portals |
|---|---|---|---|
| `ru` | ru-RU | Cyrillic | russia.bitrix24.ru, *.bitrix24.ru |
| `en` | en-EN | Latin | *.bitrix24.com |
| `de` | de-DE | Latin | *.bitrix24.de |
| `fr` | fr-FR | Latin | *.bitrix24.fr |
| `it` | it-IT | Latin | *.bitrix24.it |
| `pl` | pl-PL | Latin | *.bitrix24.pl |
| `la` | es-ES | Latin | *.bitrix24.es |
| `br` | pt-BR | Latin | *.bitrix24.com.br |
| `ua` | uk-UA | Cyrillic | *.bitrix24.ua |
| `tr` | tr-TR | Latin (dotted/dotless i) | *.bitrix24.com.tr |
| `kz` | kk | Cyrillic | *.bitrix24.kz |
| `vn` | vi-VN | Latin (heavy diacritics) | *.bitrix24.vn |
| `id` | id-ID | Latin | *.bitrix24.id |
| `ms` | ms-MY | Latin | *.bitrix24.com.my |
| `th` | th-TH | Thai | *.bitrix24.co.th |
| `in` | hi-IN | Devanagari | *.bitrix24.in |
| `ar` | ar-SA | Arabic (RTL) | *.bitrix24.com (with Arabic locale) |
| `sc` | zh-CN | Han Simplified | *.bitrix24.cn |
| `tc` | zh-TW | Han Traditional | *.bitrix24.tw |
| `ja` | ja-JP | Han + kana | *.bitrix24.jp |

### Create-task — one phrase per script family

> **Why these say "user 5" instead of a name:** the i18n probe focuses on Unicode round-trip and deadline parsing across locales — keeping the assignee as a numeric id removes the user-resolution variable. In real operator usage every phrase below would name a person ("Игорь", "Ahmet", "佐藤") and the LLM **must** run `b24_user_find` first (see section 1). For a name-resolution multilingual probe, swap "user 5" for "Igor" in each phrase and watch the LLM chain `b24_user_find` → `b24_task_create`.

The same intent — "create a task to approve a contract, assign to user 5, deadline Friday 18:00" — translated into a representative set of locales. Pick the ones matching your test portal's language; cycle through 3–4 for cross-script confidence.

| # | Locale | Phrase |
|---|---|---|
| 14.1 | `ru` (Cyrillic) | Создай задачу «Согласовать договор» исполнителю 5, дедлайн пятница 18:00. |
| 14.2 | `en` (Latin) | Create a task "Approve contract" for user 5, deadline Friday 18:00. |
| 14.3 | `de` (Latin, ß+umlauts) | Erstelle eine Aufgabe „Vertrag genehmigen" für Benutzer 5, Frist Freitag 18:00. |
| 14.4 | `br` (Portuguese Brazilian) | Crie uma tarefa «Aprovar contrato» para o usuário 5, prazo sexta-feira às 18h00. |
| 14.5 | `tr` (Turkish, dotted/dotless i) | Kullanıcı 5 için "Sözleşmeyi onayla" görevi oluştur, son tarih Cuma 18:00. |
| 14.6 | `vn` (Vietnamese, diacritics) | Tạo nhiệm vụ "Phê duyệt hợp đồng" cho người dùng 5, hạn chót thứ Sáu 18:00. |
| 14.7 | `ar` (Arabic, RTL) | أنشئ مهمة «الموافقة على العقد» للمستخدم 5، الموعد النهائي يوم الجمعة الساعة 18:00. |
| 14.8 | `sc` (zh-CN, Han Simplified) | 为用户 5 创建任务"批准合同"，截止时间周五 18:00。 |
| 14.9 | `tc` (zh-TW, Han Traditional) | 為用戶 5 建立任務「批准合約」，截止時間週五 18:00。 |
| 14.10 | `ja` (Han + kana) | ユーザー5に「契約を承認」タスクを作成、締切は金曜18:00。 |
| 14.11 | `in` (Devanagari) | उपयोगकर्ता 5 के लिए कार्य 'अनुबंध स्वीकृत करें' बनाएँ, अंतिम तिथि शुक्रवार 18:00। |
| 14.12 | `th` (Thai) | สร้างงาน "อนุมัติสัญญา" ให้ผู้ใช้ 5 กำหนดส่งวันศุกร์ 18:00 น. |
| 14.13 | `id` (Indonesian) | Buat tugas "Setujui kontrak" untuk pengguna 5, batas waktu Jumat 18:00. |

**What to look for in the response:**

- The `title` field that lands in Bitrix24 matches the source phrase byte-for-byte (open the task in the portal UI to verify).
- `responsibleId: 5` is correctly extracted regardless of the surrounding script.
- `deadline` is converted to ISO 8601 — note the LLM may guess the timezone wrong if it's not stated; this is a separate prompt-engineering issue, not an MCP bug.

### List overdue / by responsible — selected locales

| # | Locale | Phrase |
|---|---|---|
| 14.14 | `sc` | 显示我的逾期任务。 |
| 14.15 | `ar` | اعرض مهامي المتأخرة. |
| 14.16 | `ja` | 期限切れの私のタスクを表示してください。 |
| 14.17 | `tr` | Süresi geçmiş görevlerimi göster. |
| 14.18 | `br` | Mostre minhas tarefas atrasadas. |

### Comment in non-Latin script

| # | Locale | Phrase |
|---|---|---|
| 14.19 | `ar` | أضف تعليقاً للمهمة 123: «تمت الموافقة، تابع». |
| 14.20 | `sc` | 给任务 123 添加评论："已批准，继续。" |
| 14.21 | `ja` | タスク 123 にコメント追加: 「承認しました、進めてください。」 |
| 14.22 | `hi` (in) | कार्य 123 पर टिप्पणी जोड़ें: «स्वीकृत, आगे बढ़ें।» |

### Known i18n traps to watch for

- **Turkish dotted/dotless `i`** — JavaScript's `.toLowerCase()` produces unexpected results in tr-TR locale on the `I`/`i`/`İ`/`ı` set. Our `sanitizeToolName` (feedback tool) does `.toLowerCase()` without locale — fine for tool names (ASCII), but flag if we ever sanitize user input here.
- **Arabic + Trojan Source defence collision** — `stripHostileChars` (in the feedback tool only, not in task tools) strips U+202A–202E / U+2066–2069 (Bidi controls). Real Arabic text **may** carry these legitimately, especially when mixing with Latin URLs or numbers. Trade-off accepted: agent-feedback issues are short, and the GitHub UI handles base RTL fine without explicit overrides. Task titles and comments are **not** stripped — agents in Arabic locales aren't affected.
- **CJK character width** — string `length` is in code units, not visual columns. A 100-char Chinese title fits the 255-cap easily.
- **Right-to-left titles in `[agent-feedback/<kind>] <summary>`** — the `<summary>` is RTL but the prefix is LTR. GitHub renders the issue title correctly in mixed direction.

## What still won't have a tool (deliberate)

- **Delete task** — destructive, easy to misuse, not in MVP. If a user really wants it, they can complete + delete in UI.
- **"Similar task" / "related task" semantic search** — Bitrix24 doesn't expose embeddings or RAG. The LLM does this from keyword extraction over `b24_task_list` (composite).
- **CRM linkage (`UF_CRM_TASK`)** — the task-side user field is exposed via `create_task.fields` / `update_task.fields` passthrough already; no dedicated tool, agents that need it can pass the encoded value. The CRM module itself (deals / contacts / leads) is post-pilot, see [`PROJECT-BRIEF.md`](../PROJECT-BRIEF.md).
- **File attachments** — out of MVP scope; queued for after the pilot.
