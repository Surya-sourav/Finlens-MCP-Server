# Plan: Multi-Tenancy Layer for the QuickBooks MCP Server (Finlens x QB MCP)

## Context

The repo today is a **single-tenant** QuickBooks MCP server: it runs over **stdio**, registers 141 tools, and every handler pulls its QuickBooks connection from a **module-global singleton** (`quickbooksClient` in `src/clients/quickbooks-client.ts`) whose credentials come from a single `.env` (one `QUICKBOOKS_REFRESH_TOKEN` / `QUICKBOOKS_REALM_ID`). To use it, each end user must create their own Intuit Developer App and paste tokens into `.env`.

We are building a **multi-tenancy layer on top of it** so that a single **public MCP URL** serves many users. The MCP client (Claude) connects over **Streamable HTTP + bearer**; the server validates the bearer (WorkOS-issued), resolves it to a tenant, injects that tenant's QuickBooks `realmId` + access token, and dispatches to the existing handlers so every upstream Intuit API call fetches only that tenant's data. Per-tenant QB tokens are stored **encrypted** in **Neon Postgres** and refreshed automatically.

**Locked decisions (from the user):** client auth = **WorkOS AuthKit OAuth** (Finlens MCP is an OAuth 2.0 *resource server*); token encryption = **app-level AES-256-GCM** behind a swappable `KeyProvider`; DB = **Drizzle + `@neondatabase/serverless` (Neon)**; deploy = **Fly (one Node process)**; delivery = **4 phases**.

**Non-negotiable constraints baked into this plan:**
- **Zero changes to the 141 handler files and their tool wrappers.** Tenant credentials reach them implicitly via `AsyncLocalStorage`, read at the existing seam `QuickbooksClient.getInstance()` / `getAuthCredentials()`.
- **The stdio path keeps working** (`src/index.ts`, `npm run auth`, and all existing Jest tests stay green).
- **`src/` must never `import` from `Core/`.** `tsconfig.json` infers `rootDir=src/` and emits `dist/index.js` (the package `bin`/`main`); a `src → Core` import would move emit to `dist/src/index.js` and break the binary. Dependency flows **one way: `Core/` → `src/`**.

### Architecture at a glance (one Fly app, one Node process)
```
Claude ──Streamable HTTP + WorkOS bearer──▶ Fastify (Core/http)
  POST /mcp ─▶ [bearer preHandler → verify WorkOS JWT (jose/JWKS) → find-or-create tenant]
            ─▶ als.run({ tenantId, getFreshAccessToken }) around a FRESH McpServer+StreamableHTTPServerTransport
            ─▶ registerAllTools(server)  →  tool → handler → QuickbooksClient.getInstance()
                                                          └─▶ reads ALS → Vault.getFreshAccessToken(tenantId)
                                                              └─▶ Neon (Drizzle) decrypt/refresh → node-quickbooks → Intuit API
  GET /connect  (bearer)  ─▶ Intuit authorize URL (HMAC-signed state binds tenantId)
  GET /callback (public)  ─▶ verify state → intuit-oauth.createToken → Vault.upsertConnectionFromCallback (encrypt)
  /.well-known/oauth-protected-resource[/mcp] ─▶ RFC 9728 metadata → WorkOS issuer
  In-process refresh cron (setInterval) keeps tokens fresh; AuditLogger records every tool call.
```

---

## Verified facts this plan relies on
- MCP SDK **v1.20.0** is installed; `package.json` floor `^1.6.0` permits it. Wildcard export `"./*"` resolves `@modelcontextprotocol/sdk/server/streamableHttp.js` (confirmed) → `StreamableHTTPServerTransport`.
- **Stateless mode** is real: `new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })`, and `transport.handleRequest(req.raw, reply.raw, req.body)` accepts a pre-parsed body (confirmed in the SDK `.d.ts`).
- `Protocol.connect()` binds a **single** `_transport`, and `StreamableHTTPServerTransport` routes by **client-chosen JSON-RPC id** → sharing one server/transport across concurrent tenants would cross-deliver responses. **⇒ fresh server + transport per request.** `AsyncLocalStorage` protects the *credential* layer but cannot protect the transport layer; both are needed.
- The SDK auth helpers (`server/auth/router.js`: `mcpAuthRouter`, `mcpAuthMetadataRouter`, `createOAuthMetadata`, `getOAuthProtectedResourceMetadataUrl`; `middleware/bearerAuth.js`; `provider.js`: `OAuthTokenVerifier`) are **Express**. We **reuse the framework-neutral types + `getOAuthProtectedResourceMetadataUrl` + the `OAuthTokenVerifier` contract**, and **hand-roll** the two `.well-known` routes and the bearer preHandler in Fastify.
- All 141 handlers call `await QuickbooksClient.getInstance()`; exactly one (`create-quickbooks-attachable.handler.ts`) also calls `getAuthCredentials()`. Handler signatures take domain params only.
- Tests: Jest + ts-jest **ESM**, 100% coverage gate, pattern `jest.unstable_mockModule(...)` then dynamic `await import(...)`. `collectCoverageFrom` is `src/**/*.ts` (so `Core/**` is outside the gate until we opt it in — see Phase 4).

---

## Phase 1 — HTTP transport + tenant-context plumbing (no external services yet)

**Goal:** Stand up the public `/mcp` endpoint over Streamable HTTP in **stateless** mode, thread a per-request `TenantContext` via `AsyncLocalStorage`, and prove an end-to-end MCP tool call over HTTP injects a (dev) tenant's QB creds — while stdio + all existing tests stay green. Uses a **dev resolver** backed by the current global QB env vars (no DB/WorkOS yet).

**Add dep:** `fastify`.

**Refactor in `src/` (shared by both entry points):**
- `src/server/register-all-tools.ts` **(new)** — export `registerAllTools(server: McpServer): void`; move the ~130 `RegisterTool(server, XxxTool)` calls and their imports **verbatim** out of `src/index.ts`.
- `src/index.ts` — shrink to: `const s = QuickbooksMCPServer.GetServer(); registerAllTools(s); await s.connect(new StdioServerTransport());` (stdio unchanged).
- `src/server/qbo-mcp-server.ts` — add `static CreateServer(): McpServer` (fresh, non-caching); `GetServer()` delegates to it for the singleton.
- `src/clients/quickbooks-client.ts` — **DI seam + multi-tenant branch, single-tenant path untouched:**
  - Add `export interface TenantCredentialSource { getFreshAccessToken(): Promise<{ accessToken; realmId; isSandbox }> }` and a module-level `tenantResolver` with `static useTenantResolver(fn: () => TenantCredentialSource | undefined)`.
  - Gate the import-time throw: `const MULTI_TENANT = process.env.QBO_MULTI_TENANT === "true";` throw only when `!MULTI_TENANT && (!client_id || !client_secret)`; construct the singleton with `clientId: client_id ?? ""`, `clientSecret: client_secret ?? ""`.
  - Prepend to `getInstance()`: `const src = tenantResolver?.(); if (src) return QuickbooksClient.buildForTenant(src);` (else existing body).
  - Prepend to `getAuthCredentials()`: `const src = tenantResolver?.(); if (src) return src.getFreshAccessToken();` (else existing body).
  - Add `private static async buildForTenant(src)` → `getFreshAccessToken()` then `new QuickBooks(clientId, clientSecret, accessToken, false, realmId, isSandbox, false, null, "2.0")` (**no** refresh-token arg — Vault owns refresh; `.env`/`saveTokensToEnv` never run in MT mode).

**New `Core/` files (Core → src imports only):**
- `Core/transport/tenant-context.ts` — `AsyncLocalStorage<TenantContext>` with `TenantContext = { tenantId, realmId?, isSandbox?, getFreshAccessToken: () => Promise<{accessToken; realmId; isSandbox}> }`; exports `runWithTenant(ctx, fn)`, `getTenantContext()`, `requireTenantContext()`.
- `Core/http/app.ts` — `buildApp(): FastifyInstance`; calls `QuickbooksClient.useTenantResolver(() => getTenantContext())` **once** (the `TenantContext` structurally satisfies `TenantCredentialSource`, so no Core type leaks into src); registers routes + `/healthz`.
- `Core/http/mcp.route.ts` + `Core/http/handle-mcp-request.ts` — `POST /mcp`: `CreateServer()` → `registerAllTools(server)` → `new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` → `server.connect(transport)` → `reply.hijack()` → `runWithTenant(ctx, () => transport.handleRequest(req.raw, reply.raw, req.body))` → tear down transport+server on `reply.raw` `"close"`. `GET`/`DELETE /mcp` → `405` (stateless has no session/stream).
- `Core/dev/dev-resolver.ts` — a `TenantCredentialSource` that returns the current global QB env creds (bridges to the real Vault in Phase 2 so the HTTP path is testable now).
- `Core/index.ts` — server entry: `buildApp().listen({ host: "0.0.0.0", port: Number(process.env.PORT) })`.
- `tsconfig.server.json` **(new)** — `rootDir: "."`, `include: ["src/**/*.ts","Core/**/*.ts"]`, `outDir: "dist-server"`; server entry `dist-server/Core/index.js`. (Package `tsconfig.json` stays as-is → `dist/index.js` for stdio/npm.) Add scripts `build:server`, `start:server` (or run via `tsx Core/index.ts` in dev).

**Isolation guarantee:** fresh server+transport per request removes transport clobber + JSON-RPC id collision; the MT branch never touches the shared singleton's mutable `accessToken`/`realmId`, so each request's creds live only in its ALS store + stack-local `QuickBooks`.

**Verify:**
- `npm run build && npm test` → existing suite green (MT branch is dormant without a resolver).
- New `tests/unit/clients/quickbooks-client.multitenant.test.ts`: set `QBO_MULTI_TENANT=true`, inject a fake resolver, assert `getInstance()` builds a `QuickBooks` with the tenant token and `getAuthCredentials()` returns the fake creds (covers the new branches; keep/raise the per-file floor, don't lower it).
- Run the server (`tsx Core/index.ts` with dev-resolver + real sandbox QB env), point **MCP Inspector** / `curl -H "Accept: application/json, text/event-stream" -d '{...tools/list...}' http://localhost:PORT/mcp` at it → tools list + a real `get_company_info`-style call returns sandbox data.

---

## Phase 2 — Neon Postgres + Drizzle + Vault + AES-256-GCM encryption

**Goal:** Real per-tenant secret storage and token lifecycle. Swap the Phase 1 dev-resolver for the Vault: a tool call resolves `tenantId` → decrypts/refreshes tokens from Neon → hits Intuit.

**Add deps:** `drizzle-orm`, `@neondatabase/serverless`, `ws`; dev: `drizzle-kit`, `@types/ws`. **Env:** `DATABASE_URL`, `FINLENS_MASTER_KEY` (base64, exactly 32 bytes), `FINLENS_MASTER_KEY_ID` (default `local-1`).

**Schema — `Core/Vault/db/schema.ts`** (drizzle-orm/pg-core):
- `tenants` — `id uuid pk defaultRandom`, `workosUserId`, `workosOrgId`, `email`, timestamps. **Unique composite `(workos_user_id, workos_org_id)`** = the tenant key (a WorkOS user in a given org is one tenant); index on `workos_user_id`.
- `quickbooks_connections` — `id`, `tenantId → tenants.id (cascade)`, `realmId`, `encRefreshToken`, `encAccessToken?`, `accessTokenExpiresAt?`, `refreshTokenExpiresAt`, `environment` enum(`sandbox`,`production`), `status` enum(`active`,`revoked`,`error`), `lastRefreshedAt?`, timestamps. Indexes: unique `(tenant_id, realm_id)` (upsert conflict target); **partial unique `(tenant_id) WHERE status='active'`** (one active connection per tenant, keeps history + allows realm change); partial indexes on `access_token_expires_at` and `refresh_token_expires_at` `WHERE status='active'` (cron query).
- `audit_logs` — `id`, `tenantId → tenants.id (set null, nullable)`, `realmId?`, `toolName`, `category` enum(`read`,`write`,`update`,`delete`), `success`, `errorMessage?`, `durationMs`, `createdAt`; index `(tenant_id, created_at)`.
- Export `$inferSelect` types. **Tenant-key policy note:** composite `(user, org)` ⇒ **per-user** QB connection by default; the schema already supports evolving to an **org-shared** connection later (key on org only) without a rewrite.
- `Core/Vault/db/client.ts` — Neon `Pool` + drizzle instance (set `neonConfig.webSocketConstructor = ws`); `drizzle.config.ts` (`dialect: postgresql`, `schema`, `out: ./drizzle/migrations`); commit generated SQL; apply via Fly `release_command` (Phase 4).

**Encryption — `Core/Vault/crypto/`:**
- `key-provider.ts` — `interface KeyProvider { getCurrentKeyId(): Promise<string>; getKey(keyId): Promise<Buffer> }`; `LocalKeyProvider` (loads `FINLENS_MASTER_KEY`, throws if ≠32 bytes; supports a `PREVIOUS` key for rotation); `KmsKeyProvider` **stub** (throws "not implemented"; swap point for Cloud KMS).
- `envelope.ts` — `encryptSecret(plaintext, kp, aad?)` / `decryptSecret(envelope, kp, aad?)`. Format `v1:<keyId>:<ivB64>:<tagB64>:<ctB64>`; random **12-byte IV** per encryption; 16-byte GCM tag; **AAD = tenantId** so ciphertext can't be transplanted across tenants; `switch` on version for future formats.

**Vault manager — `Core/Vault/vault.manager.ts`** (`class VaultManager`, all deps injected: `db`, `keyProvider`, `makeOAuthClient(env)`, `now?`, `accessBufferMs=5*60_000`):
- `getConnectionByTenant(tenantId)` — active row or null.
- `upsertConnectionFromCallback(tenantId, {realmId, refreshToken, accessToken, expiresIn, xRefreshTokenExpiresIn, environment})` — encrypt tokens (AAD=tenantId), compute expiries, in **one transaction** revoke other active rows for the tenant then `insert … onConflictDoUpdate` on `(tenant_id, realm_id)` with `status='active'`.
- `getFreshAccessToken(tenantId): Promise<{accessToken, realmId, isSandbox}>` — **parity shape with the old `getAuthCredentials()`**. If cached access token still valid past the 5-min buffer → decrypt & return (no network). Else de-dupe via `inFlight: Map<tenantId, Promise>` (mirrors the existing `refreshInFlight` guard, keyed per tenant) → `refreshAndPersist`.
- `refreshAndPersist(conn)` — decrypt refresh token → `oauthClient.refreshUsingToken(rt)` → persist new encrypted access token + expiry, and **if the refresh token rotated, persist the new encrypted refresh token** (the "rotate or refresh silently breaks" rule, moved from `.env` to the DB). Classify failures: `invalid_grant`/400 → `status='error'` + throw `RefreshPermanentError`; network/5xx → leave `active` + throw `RefreshTransientError`.
- `revokeConnection(tenantId)` — best-effort Intuit revoke, set `status='revoked'`.
- Multi-instance note (not built now): wrap `refreshAndPersist` in `SELECT … FOR UPDATE` / `pg_advisory_xact_lock` when Fly scales past one machine.

**Wire-up:** replace the dev-resolver — the Fastify layer sets `TenantContext.getFreshAccessToken = () => vault.getFreshAccessToken(tenantId)`. (Real `tenantId` still comes from Phase 3; for Phase 2 testing seed a `tenants` row + encrypted connection and resolve a fixed tenant.)

**Verify:**
- `drizzle-kit generate` produces SQL incl. the partial `CREATE UNIQUE INDEX … WHERE status='active'`; `drizzle-kit migrate` against a Neon branch.
- Unit tests (Jest ESM, mock `@neondatabase/serverless`/`ws`/`intuit-oauth` as `quickbooks-client.auth.test.ts` does): crypto round-trip + tamper/wrong-key/wrong-AAD/unknown-version failures; vault cache-hit, refresh-on-expiry, rotation persistence, concurrent-call coalescing (one refresh), permanent vs transient failure.
- Seed one encrypted sandbox connection; HTTP `/mcp` tool call returns that tenant's data; force expiry → observe exactly one refresh + rotated token re-encrypted in the row.

---

## Phase 3 — Auth: WorkOS resource server + Intuit /connect + /callback + tenant resolution

**Goal:** Real identity. Claude's native "Connect" authenticates the user via WorkOS; the bearer is validated and mapped to a tenant; users link their QuickBooks via server-side Intuit OAuth.

**Add dep:** `jose` (JWKS/JWT verify); optional `@workos-inc/node`. **Env:** `WORKOS_ISSUER`, `WORKOS_JWKS_URI` (or derive), `MCP_RESOURCE_URL` (e.g. `https://mcp.finlens.app/mcp`), `INTUIT_STATE_SECRET`, and set `QUICKBOOKS_REDIRECT_URI=https://<host>/callback` (registered in the Intuit app).

**Auth service — `Core/Auth/auth.service.ts`:**
- `interface AuthProvider { verifyAccessToken(token): Promise<AuthInfo>; getProtectedResourceMetadata(): OAuthProtectedResourceMetadata }` (implements the SDK's `OAuthTokenVerifier` so it plugs into SDK types). `WorkOSAuthProvider` uses `jose.createRemoteJWKSet` + `jwtVerify(token, jwks, { issuer: WORKOS_ISSUER, audience: MCP_RESOURCE_URL })`; extracts `sub` (user) + `org_id` (org) + `scope`; sets `AuthInfo.expiresAt` from `exp` (the SDK bearer contract rejects tokens without it). `FakeAuthProvider` for tests. **All WorkOS uncertainties (claim names, DCR support, JWT vs opaque) are isolated in this one class.**
- **Bearer preHandler (Fastify, hand-rolled to mirror `bearerAuth.js`):** parse `Authorization: Bearer`; on missing/invalid/expired → `401` with `WWW-Authenticate: Bearer error="invalid_token", resource_metadata="<getOAuthProtectedResourceMetadataUrl(MCP_RESOURCE_URL)>"`; on missing scope → `403 insufficient_scope`. On success: **find-or-create the `tenants` row** from `(sub, org_id, email)` → set `TenantContext.tenantId` (internal uuid) and `getFreshAccessToken` before `runWithTenant`.
- **Well-known routes (hand-rolled, static JSON built at boot from `OAuthProtectedResourceMetadata`):** serve at **both** `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`; `authorization_servers = [WORKOS_ISSUER]`, `resource = MCP_RESOURCE_URL`, `scopes_supported`, `bearer_methods_supported: ["header"]`. **Discovery + DCR + code/PKCE are delegated to WorkOS** (Claude registers and does the authorization-code+PKCE flow against WorkOS directly). **Assumption to confirm in the WorkOS dashboard:** AuthKit-for-MCP exposes a `registration_endpoint` (RFC 7591) and honors `resource` (RFC 8707) for audience scoping. **Fallback if not:** bridge with a single pre-registered WorkOS client via the SDK's `ProxyOAuthServerProvider` + `mcpAuthRouter` run as a small Express sub-app (or `@fastify/express`); `AuthProvider` keeps this swappable.

**Intuit per-tenant connect (server-side; replaces the interactive `localhost:8000` flow for hosted mode — the localhost flow stays for local `npm run auth`):**
- `GET /connect` (bearer required) — mint HMAC-signed `state = base64url(payload{tenantId, nonce, iat, exp+10m}) + "." + HMAC_SHA256(payload, INTUIT_STATE_SECRET)`; build `new OAuthClient({…, redirectUri: QUICKBOOKS_REDIRECT_URI}).authorizeUri({ scope:[OAuthClient.scopes.Accounting], state })`; `302` to Intuit.
- `GET /callback` (public; integrity via signed state) — recompute + constant-time-compare HMAC, check `exp` (optional single-use nonce table); recover `tenantId`; `createToken(fullUrl)` → `{refresh_token, realmId, access_token, expires_in, x_refresh_token_expires_in}` → `vault.upsertConnectionFromCallback(tenantId, …)`; success HTML ("QuickBooks connected — return to Claude"). Keep the existing **double-code-exchange guard** (Intuit revokes on replay).

**Not-yet-connected UX:** add a `connect_quickbooks` / `quickbooks_connect_status` tool (returns `{connected, connectUrl, realmId?}`; mints the signed-state authorize URL directly since the call is already authenticated). QB data tools, on `NoConnectionError` (or `status='error'`), return a **structured, actionable** result carrying `connectUrl` (not just buried error text).

**Endpoint inventory:** `POST/GET/DELETE /mcp` (bearer), `/.well-known/oauth-protected-resource[/mcp]` (public), `/connect` (bearer), `/callback` (public+signed), `/healthz` `/readyz` (public), and the proxy OAuth routes only if the DCR fallback is used.

**Verify:**
- Unit: `FakeAuthProvider` drives preHandler tests (401/403/200, tenant find-or-create); signed-state round-trip incl. tamper + expiry rejection; `/callback` maps to `upsertConnectionFromCallback`.
- Integration: an unauthenticated `POST /mcp` returns the exact `401 + WWW-Authenticate`; add the deployed URL as a **custom connector in Claude**, complete WorkOS login, run `connect_quickbooks`, finish Intuit consent, then call a QB tool and confirm tenant-scoped data. Second WorkOS user sees only their own company.

---

## Phase 4 — Refresh cron + audit logs + deploy (Fly) + hardening

**Goal:** Keep tokens alive without cold-start latency, record every tool call, and ship to Fly.

**Refresh cron — `Core/Vault/refresh.cron.ts`** (`class RefreshCron`, deps injected):
- `start()` = `setInterval(tick, intervalMs=10min)` + `timer.unref()`; `stop()` = `clearInterval`; `runOnce()` for tests/warmup; a `running` flag prevents overlap.
- Each tick queries active connections whose `access_token_expires_at ≤ now+buffer` **OR** `refresh_token_expires_at ≤ now+7d` (served by the Phase-2 partial indexes), `LIMIT batchSize`, refreshed through a small fixed-size pool (concurrency ~5) by calling **`vault.getFreshAccessToken(tenantId)`** — the **same per-tenant in-flight Map** so cron and on-demand never double-rotate.
- Per-tenant try/catch (one dead tenant never stops the loop); `RefreshPermanentError` already set `status='error'` so it drops out next tick. `SIGTERM`/`SIGINT` → `stop()` → await in-flight → close Neon pool.

**Audit logging:**
- `Core/Vault/audit.logger.ts` — buffered `AuditLogger.record(row)` (fire-and-forget; flush on 2s timer or N rows via one multi-row insert; `flush()` awaited on shutdown).
- Hook at the **`RegisterTool` boundary** in `src/helpers/register-tool.ts` via a `withAudit(name, category, handler)` wrapper — one change instruments all 141 tools; **reuse the existing `getCrudCategory(name)`** (WRITE/UPDATE/DELETE/READ → the `audit_category` enum). It reads tenant from `getTenantContext()` and records `{tenantId, realmId, toolName, category, success, errorMessage, durationMs}`. (To keep `src → Core` clean, inject the logger via a small setter, same DI shape as `useTenantResolver`.)
- **Small tool-layer change:** propagate `isError: true` on the MCP result for business failures so audit distinguishes real failures from crashes (today errors are returned as plain text).

**Deploy (Fly, one process):**
- `Dockerfile` — build with `tsconfig.server.json` → `dist-server/`; `CMD ["node","dist-server/Core/index.js"]`; `.dockerignore`.
- `fly.toml` — internal port = `PORT`; `[[services]]` http checks → `/healthz`; **`release_command`** runs `drizzle-kit migrate` (or a `drizzle-orm/neon-serverless/migrator` script).
- Fly **secrets:** `DATABASE_URL`, `FINLENS_MASTER_KEY`, `FINLENS_MASTER_KEY_ID`, `INTUIT_STATE_SECRET`, `WORKOS_ISSUER`, `WORKOS_JWKS_URI`, `MCP_RESOURCE_URL`, `QUICKBOOKS_CLIENT_ID/SECRET`, `QUICKBOOKS_REDIRECT_URI`, `QUICKBOOKS_ENVIRONMENT`, `QBO_MULTI_TENANT=true`.
- Update `.env.example` with every new var; extend `jest.config.js` `collectCoverageFrom` to include `Core/**/*.ts` with per-file floors/exclusions for declarative files (`db/schema.ts`, `db/client.ts`, migrations) so the 100% gate holds for real logic.

**Verify:**
- Unit: `runOnce()` with a mocked vault (refreshes only expiring rows, isolates one failing tenant, coalesces with on-demand); audit wrapper records success/failure + duration and never throws into the tool path; graceful-shutdown flush.
- Deploy to Fly; confirm `release_command` migrated Neon; `curl https://<host>/healthz`; add the connector in Claude and run a full session; watch a token auto-refresh in the cron logs and rows appear in `audit_logs`.

---

## Cross-cutting notes
- **Dependency direction:** `Core/` → `src/` only. Shared code that both stdio and HTTP need (`registerAllTools`, the QB client DI seam, the audit setter) lives in `src/` and is *injected into*, never *imported from*, `Core/`.
- **Two builds:** `tsconfig.json` (unchanged) → `dist/index.js` for the stdio npm binary + existing tests; `tsconfig.server.json` → `dist-server/` for the Fly server.
- **Secrets:** QB refresh/access tokens are AES-256-GCM encrypted at rest (AAD=tenantId); `.env` is never written in multi-tenant mode; `FINLENS_MASTER_KEY` and all secrets live in Fly secrets.
- **Open item to confirm before Phase 3 build:** WorkOS AuthKit MCP capabilities (DCR `registration_endpoint`, `resource` audience honoring, JWT vs opaque tokens, exact `sub`/`org_id`/`scope` claim names). All isolated in `WorkOSAuthProvider`; a fallback (proxy provider) is specified if DCR is absent.
- **Tenant-key policy:** default = per-`(WorkOS user, org)` tenant ⇒ each user links their own QuickBooks. Org-shared connections are a documented future evolution the schema already supports.
