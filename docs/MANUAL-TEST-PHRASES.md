# Manual test phrases for the Bitrix24 MCP

`Last reviewed: 2026-05-16`

This is the operator's natural-language test pack for the MCP. Paste each phrase into Claude (or any MCP-connected LLM) with the connector enabled and observe:

1. **Which tool(s) does the LLM call?**
2. **What arguments does it pass?**
3. **Is the result what you'd expect?**

The point is to see how a real LLM **disambiguates phrasing** — not to assert exact outputs. Phrasings deliberately vary in formality, completeness, and language (Russian / English) so we can spot tool-description gaps and prompt-engineering needs.

## Legend

| Mark | Meaning |
|---|---|
| ✅ | Tool exists today (PR #4). Expect the LLM to call the right tool. |
| ⏳ | Tool **does not exist yet** — queued for a future PR. Expect the LLM to either fail gracefully or suggest a workaround. Track these as "wishlist hits". |
| 🧠 | **Composite query** — no single tool covers it. The LLM should chain existing tools (list + get + reason). Watch for hallucinated tool names. |

Setup: real Bitrix24 portal webhook in `.env`, connector wired to a chat. For each section, start a fresh conversation to avoid LLM carry-over from prior turns.

---

## 1. Basic task creation ✅

| # | Phrase | What we want to see |
|---|---|---|
| 1.1 | Создай задачу "Согласовать договор" и назначь на меня, дедлайн пятница 18:00. | `current_user` → `create_task { title, responsibleId: me, deadline }` |
| 1.2 | Add a task "Review Q2 report" for user 5, priority high, due in 3 days. | `create_task { title, responsibleId: 5, priority: "2", deadline: <iso> }` |
| 1.3 | Заведи срочную задачу: позвонить клиенту по сделке X, исполнитель Иван (id 12). | `create_task` with `priority: "2"`, `title` referencing the client / deal in plain text |
| 1.4 | Поставь задачу проверить логи прода. Без дедлайна, просто "когда руки дойдут". | `create_task` with `title`, NO `deadline`, NO `priority` (or `priority: "0"`) |
| 1.5 | Назначь задачу группе разработки (groupId 7): «Обновить зависимости». Соисполнители 14 и 15, наблюдатели 3. | `create_task` with `groupId: 7`, `accomplices: [14,15]`, `auditors: [3]` |
| 1.6 | Создай задачу с длинным описанием в BBCode: заголовок "Спецификация API", деталь — список из 5 пунктов. | `create_task` with multi-paragraph `description` containing `[*]`/`[LIST]` BBCode |

**Failure cases to probe:**
- 1.7 — Создай задачу. *(Empty)* → Zod should reject missing `title`; LLM should ask for clarification.
- 1.8 — Создай задачу "X". *(No responsible)* → LLM should default to calling `current_user` first or ask.

---

## 2. Listing & finding tasks ✅

| # | Phrase | What we want to see |
|---|---|---|
| 2.1 | Покажи мои задачи. | `current_user` → `list_tasks { filter: { RESPONSIBLE_ID: me } }` |
| 2.2 | Show my overdue tasks. | `list_tasks { filter: { RESPONSIBLE_ID: me, "<DEADLINE": <today-iso>, "!STATUS": 5 } }` |
| 2.3 | Покажи активные задачи Ивана (id 12). | `list_tasks { filter: { RESPONSIBLE_ID: 12, "!STATUS": [5,6,7] } }` — note `!STATUS` as array may need iteration |
| 2.4 | Все задачи группы 7, отсортированные по дедлайну. | `list_tasks { filter: { GROUP_ID: 7 }, order: { DEADLINE: "asc" } }` |
| 2.5 | Найди задачи со словом "договор" в названии. | `list_tasks { filter: { "%TITLE": "договор" } }` — `%` prefix is the LIKE operator in Bitrix24 |
| 2.6 | Сколько у меня задач без дедлайна? | `list_tasks { filter: { RESPONSIBLE_ID: me, "DEADLINE": null }, select: ["ID"] }`, returns `total` |
| 2.7 | Дай мне последние 10 закрытых задач Марии (id 47). | `list_tasks { filter: { RESPONSIBLE_ID: 47, STATUS: 5 }, order: { CLOSED_DATE: "desc" } }` (Bitrix returns 50/page; LLM may not slice to 10) |
| 2.8 | Поставленные мной задачи на этой неделе. | `list_tasks { filter: { CREATED_BY: me, ">=CREATED_DATE": <monday-iso> } }` |

**Probe behaviour:**
- 2.9 — Покажи задачи. *(No filter)* — LLM should call `list_tasks` and clarify after the dump if the user wanted a filter.
- 2.10 — Сколько у нас всего задач? — `list_tasks { select: ["ID"] }` → read `total`. Easy miss: LLM tries `count` which doesn't exist.

---

## 3. Updating fields ✅

| # | Phrase | What we want to see |
|---|---|---|
| 3.1 | Перенеси дедлайн задачи 123 на понедельник. | `update_task { taskId: 123, fields: { DEADLINE: <next-monday-iso> } }` |
| 3.2 | Reassign task 123 to user 5. | `update_task { taskId: 123, fields: { RESPONSIBLE_ID: 5 } }` |
| 3.3 | Переименуй задачу 123 в "Согласовать спецификацию API". | `update_task { taskId: 123, fields: { TITLE: "..." } }` |
| 3.4 | Снизь приоритет задачи 123 до низкого. | `update_task { taskId: 123, fields: { PRIORITY: "0" } }` |
| 3.5 | Добавь к задаче 123 ещё двух наблюдателей: 3 и 7. | LLM needs to GET current `AUDITORS` first, then `update_task { fields: { AUDITORS: [...existing, 3, 7] } }`. **Likely failure today** — no `get_task` tool, would need to use `list_tasks` with `ID` filter and `select: ["AUDITORS"]`. |
| 3.6 | Move task 123 to workgroup 7. | `update_task { taskId: 123, fields: { GROUP_ID: 7 } }` |

**Probe behaviour:**
- 3.7 — Обнови задачу 123. *(No fields)* — Zod refine should reject empty `fields`.
- 3.8 — Перенеси задачу 123 на завтра в 11. — LLM must compute "tomorrow at 11 in the user's timezone" → ISO 8601. Time-zone hallucinations are common.

---

## 4. Adding comments ✅

| # | Phrase | What we want to see |
|---|---|---|
| 4.1 | Прокомментируй задачу 123: «Согласовано, запускаем». | `add_task_comment { taskId: 123, text: "Согласовано, запускаем" }` |
| 4.2 | Add a comment to task 123 with BBCode: link to https://example.com labelled "spec". | `add_task_comment` with `text: "[URL=https://example.com]spec[/URL]"` |
| 4.3 | Напиши под задачей 123: «Ждём ответа от заказчика», и от имени пользователя 47. | `add_task_comment { taskId: 123, text: "...", authorId: 47 }` (may fail with permission error on non-admin webhooks — expected) |

---

## 5. Reading comments ⏳ — NEEDS NEW TOOL

**Status:** no tool today. Bitrix24 REST: `tasks.task.chat.message.list` (new, preferred) or `task.commentitem.getlist` (deprecated but works on classic task card).

| # | Phrase | What we want to see |
|---|---|---|
| 5.1 | Покажи последние 10 комментариев к задаче 123. | ⏳ `list_task_comments { taskId: 123, limit: 10, order: "desc" }` |
| 5.2 | Read the latest comments on task 123, skip the service messages about renames and time changes. | ⏳ Same + filter out `messageType: "SERVICE"` / `AUTHOR_ID: 0` (system author) |
| 5.3 | Что писали в задаче 123 на этой неделе? | ⏳ `list_task_comments { taskId: 123, ">=postDate": <monday> }` |
| 5.4 | Кто последним прокомментировал задачу 123? | ⏳ `list_task_comments { taskId: 123, limit: 1, order: "desc" }` → read `authorId` |

**Filtering service messages** is essential — Bitrix24 tracks every field change as a system comment ("user X changed title from … to …", "user Y added Z hours"). A read-comments tool that doesn't filter these is noise. The new tool should expose a `includeSystem: boolean` (default `false`).

---

## 6. Checklists ⏳ — NEEDS NEW TOOLS

**Status:** no tools today. Bitrix24 REST: `task.checklistitem.{add,update,complete,renew,delete,getlist,get,moveafteritem}`.

A task has multiple checklists; each checklist contains items. The Bitrix24 REST treats the whole tree as flat items with a `PARENT_ID` to nest. For an MCP-friendly API we'll likely expose two tools and let the agent compose:

| # | Phrase | What we want to see |
|---|---|---|
| 6.1 | Добавь чек-лист "QA" к задаче 123 с пунктами: «UI», «API», «миграция». | ⏳ Three `add_checklist_item` calls; first is the heading, next three are children with `parentId` |
| 6.2 | Поставь в чек-листе задачи 123 пункт "QA / API" как выполненный. | ⏳ `list_checklist` to find the item id, then `complete_checklist_item { itemId }` |
| 6.3 | Покажи прогресс чек-листа задачи 123. | ⏳ `list_checklist_items { taskId: 123 }`, count completed vs total |
| 6.4 | Добавь в чек-лист задачи 123 ещё один пункт «деплой». | ⏳ `add_checklist_item { taskId: 123, title: "деплой" }` |
| 6.5 | Сними отметку выполнения с пункта «деплой» в задаче 123. | ⏳ `renew_checklist_item { itemId }` |
| 6.6 | Удали из чек-листа задачи 123 пункт «UI». | ⏳ `delete_checklist_item { itemId }` |
| 6.7 | Создай в задаче 123 новый чек-лист "Релизный план" с пунктами: «changelog», «прогон тестов», «тег», «smoke». | ⏳ One header + four children |

**Proposed tools:**
- `bitrix24_add_checklist_item` (title, taskId, parentId?, sortIndex?, isImportant?)
- `bitrix24_list_checklist_items` (taskId) — returns the tree
- `bitrix24_complete_checklist_item` (itemId)
- `bitrix24_renew_checklist_item` (itemId)
- `bitrix24_delete_checklist_item` (itemId)
- (optional) `bitrix24_update_checklist_item` (itemId, title?, isImportant?)

---

## 7. Lifecycle (start / pause / complete / approve / decline / defer / renew) ⏳ — NEEDS NEW TOOLS

**Status:** no tools today. REST methods: `tasks.task.{start,pause,complete,approve,disapprove,defer,renew}`.

| # | Phrase | What we want to see |
|---|---|---|
| 7.1 | Я взялся за задачу 123. | ⏳ `start_task { taskId: 123 }` |
| 7.2 | Пауза в задаче 123, отвлекли. | ⏳ `pause_task { taskId: 123 }` |
| 7.3 | Закрой задачу 123, я её сделал. | ⏳ `complete_task { taskId: 123 }` |
| 7.4 | Прими работу по задаче 123. | ⏳ `approve_task { taskId: 123 }` |
| 7.5 | Отправь задачу 123 на доработку, исполнитель сделал не то. | ⏳ `disapprove_task { taskId: 123 }` |
| 7.6 | Отложи задачу 123, пока без приоритета. | ⏳ `defer_task { taskId: 123 }` |
| 7.7 | Восстанови задачу 123 из закрытых. | ⏳ `renew_task { taskId: 123 }` |
| 7.8 | Start working on task 123 and add a comment "поехали". | ⏳ Chain: `start_task` then `add_task_comment` |

**Proposed tools:** a single thin wrapper per lifecycle action. Each takes `{ taskId }` and returns the resulting status. Names mirror Bitrix24 REST one-to-one for predictability:
- `bitrix24_start_task`, `bitrix24_pause_task`, `bitrix24_complete_task`, `bitrix24_approve_task`, `bitrix24_disapprove_task`, `bitrix24_defer_task`, `bitrix24_renew_task`

Alternative: one `bitrix24_change_task_status` with `action: "start"|"pause"|...` enum. **Trade-off**: one tool keeps the surface smaller (LLM less likely to confuse), but loses the per-action description text where we explain when to use each. We'll likely go with **separate tools** for that reason.

---

## 8. Time tracking ⏳ — NEEDS NEW TOOLS

**Status:** no tools today. REST: `task.elapseditem.{add,getlist,update,delete,get}`.

| # | Phrase | What we want to see |
|---|---|---|
| 8.1 | Запиши в задачу 123 два часа потраченных на ревью кода. | ⏳ `add_elapsed_time { taskId: 123, seconds: 7200, comment: "ревью кода" }` |
| 8.2 | Log 45 minutes against task 123 — debugging the lockfile mismatch. | ⏳ `add_elapsed_time { taskId: 123, seconds: 2700, comment: "..." }` |
| 8.3 | Сколько в сумме потрачено на задачу 123? | ⏳ `list_elapsed_time { taskId: 123 }` + agent sums `SECONDS` |
| 8.4 | Покажи логи времени по задаче 123 с описаниями. | ⏳ `list_elapsed_time { taskId: 123 }` |

**Proposed tools:**
- `bitrix24_add_elapsed_time` — `{ taskId, seconds, comment?, userId? }`
- `bitrix24_list_elapsed_time` — `{ taskId }`

---

## 9. Subtasks ⏳ — partial support today

**Status:** Subtasks **are** just regular tasks with `PARENT_ID` set — `bitrix24_create_task` supports this **if** we surface the field. Currently our schema doesn't accept `parentId`. **One-line fix** in the next PR.

| # | Phrase | What we want to see |
|---|---|---|
| 9.1 | Создай подзадачу к 123: «Согласовать договор с юристами». | ⏳ `create_task { title: "...", responsibleId: …, parentId: 123 }` — needs `parentId` added to `create_task` schema |
| 9.2 | Покажи подзадачи задачи 123. | ⏳ `list_tasks { filter: { PARENT_ID: 123 } }` — works today, just needs description hint |
| 9.3 | Разбей задачу 123 на 3 подзадачи: дизайн, реализация, тесты. | ⏳ Three `create_task` calls with the same `parentId: 123` |

**Proposed change:** extend `create_task` input with optional `parentId`. No new tool — just a schema bump. `list_tasks` already supports `PARENT_ID` filter via the generic filter object.

---

## 10. Task linking (dependencies / related) ⏳ — NEEDS NEW TOOLS

**Status:** partial. Bitrix24 has `DEPENDS_ON` field and `tasks.task.dependence.*` (predecessor/successor). "Related" / "similar" is **not** a Bitrix24 concept — it's a search.

| # | Phrase | What we want to see |
|---|---|---|
| 10.1 | Свяжи задачу 123 с задачей 89, 123 зависит от 89. | ⏳ `add_task_dependency { taskId: 123, dependsOnId: 89 }` |
| 10.2 | Найди задачи похожие на 123 по названию и тегам. | 🧠 `list_tasks` with `%TITLE` filter using keywords extracted from 123's title; agent does the matching |
| 10.3 | Список зависимостей задачи 123 — от чего она зависит. | ⏳ `list_task_dependencies { taskId: 123 }` |

**Proposed tools:**
- `bitrix24_add_task_dependency` — `{ taskId, dependsOnId }`
- `bitrix24_remove_task_dependency` — `{ taskId, dependsOnId }`
- "Similar tasks" stays a composite query (no tool); the LLM extracts keywords and uses `list_tasks` with `%TITLE` filter.

---

## 11. Analytics / synthesis 🧠 — NO new tools, watch the composition

These phrases are about how the LLM **uses** the tools. No new endpoints — pure orchestration. The right behaviour for each is a sequence of existing tool calls plus LLM reasoning.

| # | Phrase | Expected composition |
|---|---|---|
| 11.1 | Опиши состояние задачи 123 и её подзадач первого уровня. | `list_tasks { filter: { ID: 123 } }` (or `get_task` once added) → `list_tasks { filter: { PARENT_ID: 123 } }` → list checklist (⏳) → list recent comments (⏳) → narrative summary |
| 11.2 | Какие трудозатраты по задаче 123? | `list_elapsed_time` (⏳) → sum, group by user/comment → narrative |
| 11.3 | Найди 5 похожих задач по теме «миграция БД» и расскажи как их решали. | `list_tasks { filter: { "%TITLE": "миграция", "STATUS": 5 } }` (closed only), take top 5 by `CLOSED_DATE desc` → for each: `list_comments` (⏳) and read `RESULT` if available → narrative |
| 11.4 | Проанализируй задачу 123 и подзадачи 1-го уровня — дай рекомендации. | All of 11.1 → LLM reasoning about completeness, blockers, time over-run, comment patterns |
| 11.5 | Что сейчас в работе у команды (group 7)? Кто чем занят? | `list_tasks { filter: { GROUP_ID: 7, STATUS: [2,3] } }` → group by `RESPONSIBLE_ID` → narrative |
| 11.6 | По задаче 123 — что обсуждалось в комментариях, без служебных? | `list_task_comments { taskId: 123, includeSystem: false }` (⏳) → summarise |
| 11.7 | Покажи "застрявшие" задачи — без активности > 7 дней, статус «в работе». | `list_tasks { filter: { STATUS: 3, "<ACTIVITY_DATE": <today-7d> } }` |

These composite queries are the **real test of the description quality** — the LLM has to figure out a multi-step plan without a tool named "describe-state".

---

## 12. Negative / fuzz phrases — for any section

Useful to see how robust the LLM and our error messages are.

| # | Phrase | What we want to see |
|---|---|---|
| 12.1 | Удали задачу 123. | LLM should report no `delete_task` tool exists; suggest closing instead (or queue it as future work) |
| 12.2 | Покажи задачу 999999999. | `list_tasks { filter: { ID: 999999999 } }` returns empty; LLM should report "no task found" |
| 12.3 | Создай задачу с заголовком из 1000 символов. | Zod truncates / rejects at 255 — LLM should retry or surface the error |
| 12.4 | Назначь задачу 123 несуществующему пользователю 99999. | Bitrix24 returns ERROR_CORE; our `Bitrix24ToolError` wraps it; LLM should explain |
| 12.5 | Прокомментируй задачу 123 пустым сообщением. | Zod `.min(1)` should reject |
| 12.6 | Создай задачу. Тестовая нагрузка. | Empty `title` after parse — Zod rejects |

---

## Gap analysis — tools to add (suggested next PRs)

Roughly in order of value-for-effort:

| Priority | PR scope | Tools |
|---|---|---|
| 1 | **`feat(tools): task lifecycle`** | `start_task`, `pause_task`, `complete_task`, `approve_task`, `disapprove_task`, `defer_task`, `renew_task` (7 thin wrappers) |
| 2 | **`feat(tools): task checklist`** | `add_checklist_item`, `list_checklist_items`, `complete_checklist_item`, `renew_checklist_item`, `delete_checklist_item` |
| 3 | **`feat(tools): list task comments + subtask parentId`** | `list_task_comments` (new tool, filters service messages by default); schema bump on `create_task` to accept `parentId` |
| 4 | **`feat(tools): task time tracking`** | `add_elapsed_time`, `list_elapsed_time` |
| 5 | **`feat(tools): task dependencies`** | `add_task_dependency`, `remove_task_dependency`, `list_task_dependencies` |
| 6 | **(retire `task.commentitem.add` → `tasks.task.chat.message.send`)** | Migrate `add_task_comment` to the modern endpoint; this also fixes "deprecated" warning |

After all of those land, sections 5–10 of this doc flip from ⏳ to ✅ and the analytics queries in section 11 become realistic.

---

## What still won't have a tool (deliberate)

- **Delete task** — destructive, easy to misuse, not in MVP. If a user really wants it, they can complete + delete in UI.
- **"Similar task" / "related task" semantic search** — Bitrix24 doesn't expose embeddings or RAG. The LLM does this from keyword extraction over `list_tasks` (composite).
- **CRM linkage (`UF_CRM_TASK`)** — exposed via `create_task.fields` passthrough already; no dedicated tool, agents that need it can pass the encoded value.
- **File attachments** — out of MVP scope; queued for Phase 2 alongside CRM tools.
