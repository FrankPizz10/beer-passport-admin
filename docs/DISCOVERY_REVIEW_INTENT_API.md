# Review intent API

This contract is live in production. Paths are under `/admin-api/v1` and use
the existing admin authentication. Review intent is an append-only
snapshot and does not itself select a candidate or publish an image.

`GET /discovery/candidates/:id/review-intent` returns `null` when no
intent exists, otherwise `{id, candidate_id, intent, created_at}`.

`POST /discovery/candidates/:id/review-intent` accepts
`{expected_revision: null | positive_integer, intent: ...}`. Supply
the ID returned by GET, or null when none exists. A stale revision is
refused with 409. Changes are accepted only while the candidate is
pending, and are stored with the actor in an append-only audit row.
Firebase UIDs are never returned to the client.

An image-only intent is `{mode: "image_only", target_beer_id: 42}`.
The server checks that the target exists. The reviewer must explicitly
choose the target, even when the staging match is absent. Image approval
and the final hash-bound manifest approval are separate actions.

A new-beer intent is `{mode: "new_beer", beer: {name, brewery_name,
style, abv, ibu, barcode, description}}`. Supply all fields, using null
for absent optional values; the UI can start with the staged snapshot and
change individual fields. Name and brewery are required. ABV is null or
a number from 0 to 100. The supplied values are saved separately from
the immutable source payload. The server does not silently round ABV or
trim accepted text. Image URL is not editable through this intent: a URL
change needs its own audited refetch and invalidation design.

Selecting a candidate and saving intent are separate steps. The manifest
builder records the latest revision; the importer checks that revision and
the reviewed values or image target have not changed. Schema version 2
identifies this new format. The operator must use the updated executor:
older released executors do not check manifest versions and must not be
used with version 2. Rollout and database tests are still required.
