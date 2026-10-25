# Onboarding and UI validation

## Initial recordings — 2026-10-23

The initial capability screenshots, except the replaced [`task-200.png`](#review-follow-up-probes), and `capability-demos-390x844.webm` use a standalone Vite harness that imports the actual app components and app stylesheet. Chrome viewport: 390 × 844. The harness supplies fixed demo data and local query responses; it is not the authenticated onboarding route.

- `capability-demos-390x844.webm`: briefly traverses demo arrival states, including dark and large-text cases; only the normal-text light handoff demo is held through its animation and final state.
- `*-light.png`, `*-dark.png`: demo arrival frames; `*-light-end.png`, `*-dark-end.png`: final frames.
- `*-200.png`, except the replaced `task-200.png`: root text size doubled from 16px to 32px. `approval-200-scrolled.png` and `apps-200-scrolled.png` show the lower content after scrolling.
- `layout.json`: document/main widths, touch-target measurements and animation phase checks. Every measured case stays at 390px; compact composer targets and Back measure 44 × 44px. Placeholder text measures 34px with doubled root text. The reduced-motion case stays at phase 2 rather than cycling.
- `content-fit.json`: large-text approval text fits the stacked, growing controls.
- `reduced.png`: static reduced-motion end frame.

The large-text `approval` and `handoff` entries in `layout.json` are explicitly marked historical: their Refuse and Allow once controls measured 90 × 132px each in an earlier side-by-side configuration. For the later saved stacked approval layout, `content-fit.json` records Refuse at 196 × 86px and Allow once at 196 × 132px; `approval-200-scrolled.png` shows that layout. No final handoff control geometry was remeasured or captured here: `handoff-200.png` does not show those controls, and the approval-only measurements do not validate them. These provenance annotations do not represent a new validation run.

Initial focused validation: 108 app tests passed across onboarding, approvals, chat activity, title fallback, suggestions and composer suites. The completion regression confirms that the final orb burst is shown before navigation to Chat. The standalone minified module comparison in `module-size.json` measures +1,630 gzip bytes for the onboarding route and new demo combined against HEAD. Imports were external, so this excludes dependency/chunk movement and does not establish the full production bundle delta. A full production build comparison was deferred after memory pressure interrupted the final quality gate. This harness did not record the full authenticated completion transition.

## Review follow-up probes

The [review acceptance table](../issues-47-58.md#review-follow-up-acceptance) records the later roster and touch-target checks separately from the initial artifacts. Roster semantics were checked through the actual onboarding route/query/wizard DOM harness with 0, 1 and 3 public Bots. The named image, its inert contents and visible Example counts were inspected; this was not a screen-reader session.

Close and Details were measured in installed Google Chrome using the isolated actual `NewTaskSheet` and `ApprovalCard` components and compiled production CSS. Both used a 320 × 664 CSS-pixel touch/mobile viewport and default 16px root text, with the external font import omitted for offline fallback typography. Before and after each change, the named control was center-hittable and its native activation worked as recorded in the table. Each run produced zero page errors and zero requests. These checks do not establish authenticated whole-app behavior or 200% text fit, and the initial 390px screenshots and JSON are not their measurement records. Their clickable rectangles are retained inline in the acceptance table.

The later task checks import the actual whole `TaskSheet`, real Base UI and QueryClientProvider, production query/mutation modules and application CSS. The fixture included vendored Inter under the `Inter Variable` family, while the relevant CSS requested `Inter`; the selected font was not verified. Chrome uses a 320 × 664 touch viewport; changing root text from 16px to 32px provides 200% rem-based enlargement. Failed and `needs_input` states were measured at both sizes, including the final Close correction. Requests use local fixture transport or are rejected; there is no app server or authenticated whole-app navigation. The conversation-detail query is deliberately disabled/pending, so ChannelChat, report and composer are absent. This bounds the browser evidence to sheet header controls, layout and scrolling; it does not validate those conversation surfaces at 200%.

[`task-200.png`](task-200.png) now shows the final isolated TaskSheet in the failed state at 320 × 664, 32px root, with the vendored font included but its selection unverified. The header is scrolled to show Mark done, Try again and Close; the lower failure text continues within its scroll region, and the blank conversation area reflects the disabled query. Native wheel scrolling separately exposed the final failure sentence. The inline [acceptance table](../issues-47-58.md#review-follow-up-acceptance) retains before/after measurements and activation results. The `task` entries in `layout.json` and the other task images remain initial 390px capability-demo evidence and do not describe this replacement screenshot. Initial test totals and outstanding full-build/CI limits remain unchanged.

## Bot computer live check

`computer-live.png` is from the isolated fake stack at app port 3041 / API port 3141. A user message explicitly asked the Bot to open `https://example.com` using its computer browser, without web search. The Bot completed the browser visit and returned the page title “Example Domain” and its first sentence. A subsequent `POST /api/openduet/setup/check` returned the computer row with `status: ready` and `ready: true`. The isolated server log contained no egress-policy push failure or 401 for this check. No credentials are included in the artifacts.

The two existing local APIs (real `:3130`, fake `:3131`) were also gracefully restarted with their existing source/configuration and the synchronized computer token after checking that neither had active durable work. Both returned healthy afterward, with zero 401 or egress-policy failure log lines. No credential values were printed or added to the repository.

## Authenticated onboarding route

`authenticated-onboarding-390x844.webm` records all nine actual onboarding steps on the isolated fake stack, completion save, the orb finish burst and navigation into Chat. Each step measured document width 390px at viewport 390×844. `authenticated-layout.json` records those measurements. `authenticated-finish-burst.png` shows the completion state; `authenticated-chat-started.png` and `authenticated-chat-greeting.png` show Chat with the Bot greeting and working immediately after navigation. The account's prior onboarding and archived-channel state was restored after recording. No production data was changed.
