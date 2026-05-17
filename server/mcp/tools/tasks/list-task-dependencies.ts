import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useBitrix24 } from '~/server/utils/bitrix24'
import { callV2 } from '~/server/utils/sdk-helpers'
import { toNumber } from '~/server/utils/wire-coerce'

/**
 * List the predecessor tasks that a Bitrix24 task depends on.
 *
 * Bitrix24 REST: task.item.getdependson (v2)
 *   https://apidocs.bitrix24.com/api-reference/tasks/deprecated/task-item/task-item-get-dependson.html
 *
 * The endpoint is **marked deprecated** in the apidocs (recommendation:
 * use `tasks.task.get` instead). However, as of 2026-05 no v3
 * `tasks.task.dependence.list/get` endpoint exists, and `tasks.task.get`
 * does not document a `dependsOn`/`predecessors` field — there is no
 * supported v3 alternative for reading a task's dependency list. We use
 * `task.item.getdependson` until Bitrix24 ships a v3 replacement and
 * mark this with a TODO(live) so the pilot can validate the endpoint is
 * still served.
 *
 * Known information limitation: `task.item.getdependson` returns just
 * an array of predecessor task IDs — it does NOT surface the per-link
 * `linkType` (SS / SF / FS / FF) that `task.dependence.add` accepts.
 * Operators wanting to inspect the link types would need to do that
 * through the Bitrix24 UI. Tracked as #34 (post-pilot revisit). If a
 * future Bitrix24 release exposes the richer shape (e.g. via a v3
 * endpoint or a `tasks.task.get` select field), this tool's response
 * can grow `linkType` per row in a backward-compatible way without
 * breaking callers that only read `dependsOn`.
 *
 * Returns successor-direction info too? No — `task.item.getdependson`
 * is one-way (predecessors of the given task). The inverse — "tasks
 * that depend ON this one" — would need a separate endpoint /
 * `tasks.task.list` filter; out of scope for the pilot.
 *
 * TODO(live) #33: verify `task.item.getdependson` still responds on a
 * live Bitrix24 portal. The endpoint is deprecated; the apidocs page
 * may survive longer than the actual server-side route. The tool's
 * defensive "empty array on unrecognised shape" path means a silently-
 * decommissioned endpoint returns `dependsOn: []` rather than an
 * error — passing the live smoke is a hard prerequisite to declaring
 * Phase 2 pilot-ready.
 */

/**
 * Operator-facing warning attached to every response. The endpoint is
 * deprecated upstream and we have no error signal if Bitrix24 silently
 * decommissions the route (the defensive fallback would just produce
 * `dependsOn: []`). Shipping the warning in-band means an agent / pilot
 * operator sees the risk on every call — even if the live-smoke gate
 * (#33) eventually slips. Removed (along with the deprecated dependency)
 * once Bitrix24 ships a v3 `tasks.task.dependence.*` read endpoint.
 */
const DEPRECATED_ENDPOINT_WARNING =
  'task.item.getdependson is deprecated upstream; if `dependsOn` is unexpectedly empty for a task you know has predecessors, verify in the Bitrix24 UI and check issue #33.'

export default defineMcpTool({
  name: 'bitrix24_list_task_dependencies',
  description:
    'List the predecessor tasks ("Предыдущие задачи") that a Bitrix24 task depends on. Returns an array of predecessor task IDs. Does NOT return the per-link `linkType` (SS/SF/FS/FF): the current read endpoint (`task.item.getdependson`) only exposes predecessor ids, and as of 2026-05 no REST method documents a way to read the link types back. Operators wanting that view should use the Bitrix24 UI. Returns an empty array when the task has no predecessors — the response also carries a `_warning` field flagging the deprecated upstream endpoint, so an unexpectedly-empty result deserves a UI cross-check. To MODIFY links, use `bitrix24_add_task_dependency` / `bitrix24_remove_task_dependency`.',
  inputSchema: {
    taskId: z
      .number()
      .int()
      .positive()
      .describe('Task id to list predecessors for. Required — there is no portal-wide listing for this endpoint.'),
  },
  handler: async ({ taskId }) => {
    const b24 = useBitrix24()
    // The endpoint is documented with both positional `[TASKID]` (JS
    // examples) and named `{ TASKID }` (PHP examples). We use the named
    // form — explicit, works with the SDK serialiser, and matches the
    // HTTP-payload shape shown in the apidocs Response Handling block.
    const data = await callV2<unknown>(
      b24,
      'task.item.getdependson',
      { TASKID: taskId },
      `Failed to list Bitrix24 task ${taskId} dependencies`,
    )

    // The endpoint usually returns a flat `number[]` / `string[]` of
    // predecessor ids. We additionally accept a `{ result: [...] }`
    // envelope as a defensive mirror of `list_elapsed_time`'s pattern
    // (no documented evidence this shape ships from getdependson, but
    // the cost of the extra branch is zero and it makes the tool
    // resilient to portal-version drift). `toNumber` coerces
    // numeric-strings — Bitrix24 occasionally ships ids that way on
    // legacy v2 endpoints.
    const rawIds: unknown[] = Array.isArray(data)
      ? data
      : Array.isArray((data as { result?: unknown[] })?.result)
        ? (data as { result: unknown[] }).result
        : []

    const dependsOn = rawIds
      .map((value) => toNumber(value))
      .filter((value): value is number => value !== null && value > 0)

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            taskId,
            // `returned` mirrors the list-tools convention (list_tasks,
            // list_elapsed_time, list_task_results) — Bitrix24's v2
            // getdependson doesn't ship a paginated `total`, so the
            // agent compares `returned` against expected scale. With no
            // documented pagination on this endpoint we expect the full
            // list in one shot regardless of size.
            returned: dependsOn.length,
            dependsOn,
            _warning: DEPRECATED_ENDPOINT_WARNING,
          }),
        },
      ],
    }
  },
})
