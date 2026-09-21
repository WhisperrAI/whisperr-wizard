/** Shared contract recipe for the existing integration runner. This guidance
 * does not grant backend access or add a catalog provisioning phase. */
export const CATALOG_INTEGRATION_GUIDANCE = `
CATALOG INTEGRATION — apply when catalog-backed messaging is in the approved scope.
Use the existing runner and repository permissions. An event catalog is NOT a
product catalog. If the current repository cannot expose the authoritative feed,
record the backend repository/endpoint as a follow-up; never fake provisioning
or modify an unavailable repository. Ordinary event-only runs stay event-only.
Backend catalog work does NOT authorize new frontend screens, inbox tabs,
push handlers, token registration, product-loading behavior or navigation changes.
An events-only frontend PR adds identify/reset and truthful existing-action events
only. Any visible UX or message-routing integration needs explicit separate scope;
never infer it from a request to connect a backend product catalog.

Inspect the real backend models, migrations, API responses, publication gates,
translations, currency representation and order/fulfillment rules before mapping.
Catalog definitions can live in admin-managed models; reading those definitions
does not make an administrator the end user. Trace each product to its actual
owner and verified available locations. A parent/branch relationship or shared
product source does not imply inherited availability, pricing or orderability.
Distinguish public facts from personalized state, order history and credentials.
Unsupported conditional offers or ambiguous branch mappings need explicit issue
codes or unknown/unavailable status, never a fabricated eligibility claim.

Use Whisperr spec contracts/11-catalog-feed.md and schemas/catalog-feed.schema.json.
One protected HTTPS GET feed, dedicated bearer token, immutable complete snapshots.
Every page: schema_version "1.0", stable snapshot_id/generated_at/total_items,
items, issues, complete and next_cursor. Maximum 200 items/200 issues per page;
complete is true exactly when next_cursor is null. Follow an opaque cursor on the
same URL, not a provider-supplied next URL. Persist a consistent snapshot while
paging; a moving offset query is not a snapshot. Validate counts, duplicate IDs,
references and localized facts. Only a complete validated snapshot removes absent
items. Failed/incomplete refreshes retain prior data until its original freshness
deadline; fetching an old snapshot does not renew freshness.

Use stable connection-scoped source_item_id, explicit available_at/applies_to/
parent/product_source references, localized name/description, and integer minor
currency units with price meaning. Keep native route IDs separate from catalog
IDs: e.g. source_item_id product:8, action target id "8" and location_id "42".
Validate both flat-shop and venue/product fixtures against the SAME contract.
An available catalog item means discovery, not personal redeemability. Structured
buy_x_get_y terms remain conditional; no unconditional savings, stock, opening
hours or eligibility promise without current supporting evidence.

Identity is the same stable backend external user ID on every surface, as a
string (e.g. numeric user 123 becomes "123"), scoped to the Whisperr app. Never
substitute email, phone, device ID, an admin ID or a different auth provider ID.
Client events describe confirmed detail views, selections and checkout entry.
Business outcomes come from committed backend transitions, never UI rendering,
payment WebView navigation, QR display, or reading historical orders. Preserve
event ID, original occurred_at and payload through durable outbox retries; an
in-memory SDK queue/shutdown flush is not crash-durable business delivery.

Only if message delivery/navigation is explicitly in scope: push uses existing
direct Whisperr FCM delivery; no second sender or callback
that sends the same notification again. Versioned action:
{version:1,type:'view_item',target:{kind:'location'|'product'|'offer'|'plan'|'content',id:string,location_id?:string}}.
Venue-owned product destinations need the actual owning location; flat catalogs
can omit location_id. Do not require hierarchy in the shared contract. FCM data keys are
whisperr_message_id, whisperr_user_id, whisperr_action (JSON string). Only parse
Whisperr-prefixed payloads. Public SDK keys cannot read message history; a backend
proxy derives the user from its authenticated session and uses a bound server
producer credential. Server history survives missed pushes. Resolve owned
message + live target before navigation; never trust push parameters as permission.
Test foreground, cold start, login deferral, wrong-account login, logout/account
switch, deleted products and failed history pagination. Never auto-redeem.

Readiness is evidence-based: code implemented, local checks passed, deployed,
complete feed synchronized, and events/device actions observed are SEPARATE facts.
Do not claim deployed, synchronized, observed or ready because a PR or fixture test
exists. Document build configuration, source binding, runtime credentials and
scheduler requirements without printing secrets. Missing access/configuration
is a concrete follow-up, not a reason to invent a successful setup.
`.trim();

export const CATALOG_REVIEW_GUIDANCE = `
For catalog-related changes, apply the existing review rule catalog to identity,
intent-versus-outcome timing, native catalog references, original event timestamps,
and source-event idempotency. Check startup readiness before draining events,
identity before account-success signals, and bounded disabled/failed queues.
A historical order read is not a new redemption. A product view is not a purchase.
Check authenticated history, recipient isolation, availability revalidation and
unavailable-target fallback. A compiled callback is not proof of an active route.
Report only evidenced changes within this review's allowed scope; do not invent
new review rule IDs or claim deployment/live verification from local checks.
`.trim();

export const REPOSITORY_READINESS_NOTICE =
  "Repository checks describe the code only. Deployment, a complete catalog refresh, " +
  "and observed customer events require separate evidence and are not verified by this run.";

export const FLUTTER_CATALOG_GUIDANCE = `
For a Flutter events-only integration, use identify, track and reset on existing
business paths. Do not add message action/history SDKs, inbox screens, tabs,
notification handlers, native token changes or navigation. Those require explicit
separate scope. Verify actual SDK exports and compatible runtime requirements;
use a verified published release or an explicitly reviewed immutable Git commit,
never invent an unpublished version.
Initialize off the startup critical path, then restore the real backend identity
BEFORE draining any startup events. Set adapter readiness before binding callbacks.
Capture the user at event occurrence so pending events cannot move to the next
account. Signed-out events require an explicitly supported anonymous identity
contract; otherwise report them unsupported instead of silently losing them.
Bound startup queues, handle asynchronous errors, and expose missing configuration.
Only for separately authorized delivery/navigation work, reuse existing FCM
handlers and exact-token consent semantics; do not introduce a second sender.
Such work must receive its own scoped review and user-visible change summary.
`.trim();

export const PHP_CATALOG_GUIDANCE = `
For PHP catalog/outcome integration, inspect composer.json/lock and the actual
runtime. Verify a shared whisperr/php version compatible with PHP 8.0/Laravel 8
when required; do not invent a customer-specific HTTP SDK or bypass Composer.
Authoritative outcomes need a transactional durable outbox: persist the committed
transition and outbox row together, then publish after commit. The shared SDK's
publish(externalUserId,eventType,properties,messageId,occurredAt,context) keeps
caller-supplied identity/time and returns a receipt. Dequeue ONLY when
acknowledged() is true. Preserve rows for retryable failures; surface permanent
failures instead of recording success. An ingestion receipt is not a processed
outcome. Use identifyNow for acknowledged consent/token updates, keeping exact
old-token revocation and new-token registration ordered and durable. Check these
methods exist in the chosen SDK before coding; missing release is a dependency.
Catalog polling and business-event delivery are separate responsibilities. Store
only minimized public catalog facts in the protected feed; no users/orders.
`.trim();
