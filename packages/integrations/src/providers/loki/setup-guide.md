# Grafana Loki — setup guide

Applies to a **single-binary**, a **microservices** and a **Grafana Cloud Logs** deployment.
Everything below is from Grafana's published documentation, retrieved 2026-09-10; where the
documentation says nothing, this guide says so rather than guessing.

The platform queries Loki in exactly one place (product/08, Q16): the optional **log excerpt**
around a Sentry event's timestamp for a bug task. Agents query it themselves through `logcli`.

## 1. Decide how the binding authenticates

Loki has no built-in authentication; deployments put it behind a gateway, a reverse proxy or
Grafana Cloud. The binding therefore states its mode **explicitly** — a missing credential must
never silently become an anonymous query, because an anonymous query comes back empty and an empty
answer reads as "the error stopped".

| `auth_mode` | What is sent | Use it when |
|---|---|---|
| `bearer` (default) | `Authorization: Bearer <bearer_token>` | Grafana Cloud, or a gateway that takes a token. |
| `basic` | `Authorization: Basic …` from `username` + `password` | A reverse proxy with HTTP basic auth. |
| `none` | no `Authorization` header | A Loki reachable only on a private network. **A deliberate choice**, and the platform will not make it for you. |

With `bearer` or `basic`, a missing, empty or whitespace-only credential is a refusal issued before
any request is sent.

## 2. Configure the binding

| Field | Required | What it is |
|---|---|---|
| `base_url` | yes | Loki root — `https://loki.internal:3100`, or your Grafana Cloud logs endpoint. **Not** the `/loki/api/v1` path, and no trailing slash. |
| `auth_mode` | no (`bearer`) | See step 1. |
| `bearer_token` | with `bearer` | Secret. |
| `username` / `password` | with `basic` | `password` is secret. |
| `tenant_id` | multi-tenant only | Sent as `X-Scope-OrgID`. Leave unset on a single-tenant instance. |
| `request_timeout_ms` | no (30 000) | Per-request timeout. |

### Caps — and why they are refusals rather than clamps

The port publishes two of them in `capabilities()`, and the port's own docblock says why they are
enforced: *"a truncated answer looks like a complete one to an agent reasoning about whether an
error still happens"*. A query that exceeds either is `invalid_request`; a result that hit a limit
carries `truncated: true`.

| Field | Default | What it bounds | On breach |
|---|---|---|---|
| `max_range_ms` | 24 h | Widest window one query may cover — `queryRange` **and** `series`, whose window runs from `since` to now. | refused |
| `max_lines` | 1 000 | Highest `limit` one query may ask for. | refused |
| `max_filter_length` | 256 | Characters in a line filter. | refused |
| `max_line_bytes` | 8 192 | Bytes of **one** line. A 50 MB base64 blob is one line. | truncated with a marker, `truncated: true` |
| `max_label_bytes` | 1 024 | Bytes of one label **name** and one label **value**, wherever a label is emitted. | truncated with a marker, `truncated: true` |
| `max_labels` | 64 | Labels kept per stream. The set is copied onto every line, so it is part of the answer's size. | marker label, `truncated: true` |
| `max_label_values` | 1 000 | Values returned by `labels()`. | marker value |
| `max_series` | 500 | Label sets returned by `series()`. A cap on one label is not a cap on the list. | marker label set |
| `max_total_bytes` | 1 048 576 | Bytes across the whole result of `queryRange` **and** of `series`, counting each line **and the labels copied onto it**. | stops early with a marker, `truncated: true` where the answer carries the flag |
| `label_lookback_ms` | 6 h | Window `labels` and `series` use — the port gives them none, and Loki's own default is 6 hours. | — |

The result is therefore bounded by
`max_total_bytes + (max_line_bytes + max_labels × 2 × max_label_bytes) + one marker`: the middle
term is the single line that is always kept, so that a budget smaller than the first line answers
with something rather than with nothing. A `series` answer is bounded the same way with one label
set in the middle term, and a `labels()` listing by `max_label_values × max_label_bytes`. Each
marker is counted **inside** the cap that emitted it, so applying a cap twice changes nothing.

Raise `max_range_ms` and `max_lines` only with the token budget in mind: a log excerpt goes into a
context pack, and WP-16 pays for every line.

## 3. What LogQL this binding will send

`queryRange` writes exactly one shape of query and refuses everything else:

```
<validated stream selector>  [ |= "<escaped literal>" ]
```

- the **selector** must be a stream selector — `{app="api", env="production"}` — with Loki's four
  documented matchers (`=`, `!=`, `=~`, `!~`) and either quoting form. A line filter, a parser
  stage (`| json`) or an aggregation (`count_over_time(...)`) in the selector is `invalid_request`;
- the **filter** is treated as a **literal substring**, always, and escaped into the query. It is
  never interpreted as LogQL, because a filter can arrive from a ticket, a Sentry tag or an agent,
  and LogQL concatenated from untrusted text is injection with a query language instead of a shell
  (BD-022).

An operator or an agent who needs the rest of LogQL uses `logcli` (step 5).

## 4. What the platform reads, and what it never does

Read-only, always: `GET /loki/api/v1/query_range`, `/labels`, `/label/<name>/values`, `/series`.
The binding never pushes, never deletes and never touches the ruler.

Two behaviours worth knowing before you read a result:

- **ordering is global.** Loki orders entries within a stream; the adapter sorts every line across
  streams so that "newest first" is true of the whole answer. One label set may therefore appear in
  more than one `streams` entry;
- **timestamps are nanoseconds** and are read as `BigInt`. A `Number` would silently lose the low
  digits.

## 5. Agent tooling — `logcli`

The runner may mount `logcli` on the agent's PATH. The spec declares **names only** (BD-002,
BD-025); the run-scoped credential is resolved by the runner from the secret store.

| Variable | Secret | What it is |
|---|---|---|
| `LOKI_ADDR` | no | Server address — Grafana documents "Server address. Can also be set using LOKI_ADDR env var." |
| `LOKI_BEARER_TOKEN` | **yes** | "adds the Authorization header to API requests for authentication purposes". Run-scoped and read-only. |
| `LOKI_ORG_ID` | no | "adds X-Scope-OrgID to API requests for representing tenant ID". Unset on a single-tenant instance. |

`LOKI_USERNAME` and `LOKI_PASSWORD` are documented by Grafana, are listed in `.env.example` for an
operator running `auth_mode: basic`, and are **deliberately not declared as agent tooling**:
the credential an agent gets is a read-only token, and naming a basic-auth pair would invite an
operator to inject the binding's own account into a run container.

Give the agent's token read access to the same tenant and nothing else. It lives for the run.

## 6. Test connection

*Test connection* performs one read-only call, `GET /loki/api/v1/labels` over the label-lookback
window. It never mutates. Common failures:

| Result | Usually means |
|---|---|
| `auth_mode is "bearer" but no bearer token is configured` | The secret is missing, empty or whitespace. Nothing was sent. |
| `… answered 401` / `403` | The gateway rejected the credential, or a multi-tenant Loki was queried without `tenant_id`. |
| `… answered 404` | `base_url` points at something that is not Loki, or already carries `/loki/api/v1`. |
| `… could not be reached` | DNS, TLS or the egress policy (TD-021). |

The `detail` line is run through the secret redactor before it is stored, so a probe can be shown
in the settings screen without leaking what was sent.

## 7. A note on rate limits

Grafana publishes per-tenant query limits as *operator* configuration (`limits_config`), not as
something a client can read, and the HTTP API reference has no status-code table. The binding
therefore asks for a small budget by default, treats `429` as retryable, and honours a `Retry-After`
if a proxy sends one. If your Loki is shared with dashboards and alerting, leave it small.
