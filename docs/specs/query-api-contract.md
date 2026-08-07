# Structured API contract addendum

Content-script API requests MUST use `credentials: "include"` so the current
logged-in page session is inherited. Only JSON responses from documented
`layy`, `layy/count`, `layyxq`, `layymb`, and `ajlist` endpoints are accepted.
401/403, login redirects, non-JSON responses, and transport errors produce
`needsHuman=true` and no guessed fields.

Paged results are accepted only when the sum of rows equals `data.total`.
Unknown or drifted field signatures, duplicate signatures, or any API/DOM
page/order/count mismatch produce `UNKNOWN` with `needsHuman=true`. DOM rows
are matched bidirectionally by case name, parties, cause, and application date;
array position is not an identity.

The case-space button may create a new browser tab; the executor must adopt and
wait for that tab. `shjgs` is selected by the unique latest parsed `shsj`;
missing latest fields or tied latest timestamps require manual review.
