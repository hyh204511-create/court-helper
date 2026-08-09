# Query performance specification

## Scope

This specification covers safe performance improvements for a single logged-in platform account with at most 10 cases. It does not change the query data sources, state mapping, evidence rules, or export gate.

## Rules

- Keep one browser page/session serial for all DOM actions. Do not use `Promise.all` for category switching, search clicks, row selection, screenshots, or detail-page handoff.
- Keep the existing 3–8 second random delay between case operations and keep the one-retry-then-manual rule.
- Apply the random delay only between adjacent case operations. Do not add a trailing delay after the last case in a batch or after the last `ajlist` evidence candidate. A retry keeps its own delay before the single retry, independently of the between-case delay.
- After a structured `layy/count` response confirms `total=0`, skip the corresponding list-page request. Return an empty structured result only; the caller must still use the existing DOM-empty confirmation before clearing that category's local records.
- During one `QUERY_ALL_EXPORT` run, memoize only identical `ajlist` evidence requests in memory. Cache successful responses; failed responses must not be cached so the normal retry/manual path remains available. Never persist the cache or include business values in logs.
- Page readiness remains event/DOM driven with the existing bounded timeout. A performance change must not treat stale rows, unknown text, or an API-DOM mismatch as success.
- Read the independent filing and enforcement IndexedDB stores concurrently during export. Convert evidence image blobs concurrently, but add them to the workbook in the original deterministic order so row/image anchors do not change.
- Reuse the byte buffer produced by ExcelJS for the local download, SHA-256 digest, and base64 upload handoff. The downloaded bytes, decoded upload bytes, and digest input must be identical.

## Out of scope

- Parallel browser actions in the same account/session.
- Removing screenshots, API-DOM matching, pagination conservation, or strict field validation.
- Lowering the 3–8 second throttle or increasing the 50-item batch limit.

## Acceptance

- A zero-count category makes one structured count request and no structured list request.
- Repeated identical evidence requests in one run make one successful API request; a failed request is eligible for a later retry.
- A successful batch of N cases performs exactly `max(0, N - 1)` between-case delays. A failed first attempt still performs its retry delay; a completed last case does not add a trailing delay.
- N evidence candidates perform exactly `max(0, N - 1)` between-candidate delays.
- Export preserves workbook row order, image count and H/K/P/S anchors, while downloaded bytes, uploaded bytes, and the SHA-256 input remain identical.
- For the typical two-category flow, removing the four possible trailing delays saves 12–32 seconds without lowering the 3–8 second interval between actual case operations.
- Existing full test and build gates remain green.
