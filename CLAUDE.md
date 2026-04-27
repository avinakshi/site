# Claude Code — Build Instructions
## AI-Assisted Customer Success Chat System (Phase 1 MVP)

> **How to use this document:** Save as `CLAUDE.md` in your repo root. Open Claude Code in that directory. The first prompt to Claude Code is: *"Read CLAUDE.md and execute Step 1. Stop when done and wait for me to confirm before Step 2."*
>
> Each step has a clear stop point. Do not let Claude Code run all 14 steps in one shot — that's how you end up with broken integrations and no way to debug them.

---

## YOUR ROLE

You are a senior full-stack engineer building this system end-to-end. You are working with someone who is technical but not deep in every framework — explain decisions in commit messages, not in chat. Stay in flow.

**Operating principles:**
1. Read this entire document before writing any code.
2. Execute one step at a time. STOP at the end of each step and report what was done.
3. If something is ambiguous, ask. Do not guess.
4. If you discover a real problem with the spec while building, raise it — don't silently fix.
5. Write tests as you go. No "I'll add tests later."
6. Commit after each working sub-step with conventional commit messages.

---

## PRODUCT IN ONE PARAGRAPH

CSMs send emails to clients with a unique chat link. Client clicks the link, lands on a web chat, talks to the CSM in real time. All conversations stored. CSMs have a dashboard to manage active chats. Phase 2 will add AI fallback (Gemini API) and WhatsApp escalation — **do not build those now**, but the schema includes forward-compatible hooks (`messages.metadata jsonb`, `sessions.ai_intervention_count`, sender enum extensible to `'ai'`) so Phase 2 slots in without migrations. Phase 2 design is locked separately in `PHASE2_AI_DESIGN.md` — **do not read or act on that file during Phase 1.**

---

## LOCKED STACK — DO NOT SUBSTITUTE

| Layer | Choice |
|-------|--------|
| Frontend | Next.js 14 (App Router) + TypeScript + Tailwind + shadcn/ui |
| Backend | Fastify 4.x + TypeScript + Node.js 20 LTS |
| Real-time | Socket.IO 4.x (single instance, no Redis adapter for MVP) |
| Database | PostgreSQL 15+ (Supabase-hosted, India region) |
| ORM | Drizzle ORM + drizzle-kit migrations |
| Validation | Zod (shared between routes and DB) |
| Auth | bcrypt + JWT (jose library) |
| Logging | Pino (JSON structured) |
| Errors | Sentry (frontend + backend) |
| Hosting | Railway (API), Vercel (web) |
| Package manager | pnpm workspace |
| Testing | Vitest + Supertest + Playwright |

**Phase 2 placeholders (DO NOT IMPLEMENT IN PHASE 1):**
- `GEMINI_API_KEY` env var (commented out in `.env.example`)
- `messages.metadata jsonb` column (leave empty `{}` in Phase 1)
- `sessions.ai_intervention_count` column (always 0 in Phase 1)
- `messages.sender_type` enum (Phase 1 uses only `client | csm | system`)

Do NOT import Gemini SDK, do NOT create `ai.service.ts`, do NOT add prompt-related code. Phase 2 design is in `PHASE2_AI_DESIGN.md` — leave it alone for now.

---

## EXPLICITLY OUT OF SCOPE FOR PHASE 1

Do NOT build any of these. If you find yourself starting on one, stop:
- AI chat / Gemini integration / any LLM SDK
- WhatsApp / Twilio
- Email integration (Outlook, Gmail, Microsoft Graph)
- File / image attachments in chat
- Typing indicators, read receipts
- Multi-CSM routing, round-robin, queues
- Voice / video
- Internationalization (English only)
- White-label / multi-tenant branding
- CRM sync
- Conversation search / full-text search
- Browser push notifications
- Mobile native apps
- Admin analytics dashboard

The schema includes nullable columns for some Phase 2 features (`email_thread_id`, `ai_intervention_count`) so Phase 2 doesn't need migrations. Leave them unused for now.

---

## REPO STRUCTURE

```
csm-chat/
├── apps/
│   ├── web/                # Next.js frontend
│   └── api/                # Fastify backend
├── packages/
│   ├── db/                 # Drizzle schema + migrations
│   └── shared/             # Zod schemas, types, error codes
├── .github/workflows/
├── pnpm-workspace.yaml
├── package.json
├── turbo.json
├── .env.example
├── README.md
├── SECURITY.md
├── CLAUDE.md               # This document (Phase 1)
└── PHASE2_AI_DESIGN.md     # Locked Phase 2 design — DO NOT TOUCH IN PHASE 1
```

---

## SECURITY MODEL (READ CAREFULLY — IT'S THE SPINE)

### Three identity types

| Type | Auth | Token |
|------|------|-------|
| **Client** (end customer) | Signed JWT in URL + device-bound httpOnly cookie | URL token (7d) → session JWT (1h) after `/chat/verify` |
| **CSM** | Email + password | Access JWT (15min) + refresh token (30d, DB-tracked, rotates) |
| **Admin** | Email + password | Same as CSM, role=admin |

### Client session flow (memorize this)

```
1. CSM creates session → server generates JWT { sid, exp:7d, iat, ver:1 }
   signed with HMAC-SHA256 (SESSION_TOKEN_SECRET).
   Server stores SHA-256 hash of token in sessions.token_hash (NEVER raw).
   Returns chat URL: https://app.example.com/c/{token}

2. Client clicks URL → frontend POST /v1/chat/verify { token }

3. Server validates IN ORDER (fail fast):
   a. JWT signature → 401 INVALID_TOKEN
   b. JWT exp → 401 TOKEN_EXPIRED
   c. token_hash exists in DB → 401 INVALID_TOKEN
   d. session.status in (pending, active, csm_handling) → 410 SESSION_CLOSED
   e. Device cookie csm_chat_device present?
      YES + matches session_devices row → OK
      YES + doesn't match → 403 DEVICE_MISMATCH (one-device-per-session)
      NO → first visit. Create session_devices row, set httpOnly cookie.
           Set session.status='active', first_accessed_at=now().

4. Server returns:
   { sessionId, clientName, csmName, status,
     sessionJwt (1h), wsToken (single-use, 60s, for Socket.IO) }

5. Frontend stores sessionJwt IN MEMORY (not localStorage).
   Connects Socket.IO with wsToken in handshake auth.
```

### One-device-per-session rule

This is intentional. If a client opens the link on phone and then tries laptop, they get blocked. CSM regenerates a new link if needed. Simpler than email OTP, more secure than no binding.

### CSM auth

> **Refresh token transport (decided 2026-04-27):** httpOnly cookie `csm_refresh` only — never returned in JSON body. See §"API Endpoints → Auth" for the cookie attributes and endpoint contract.

- Login: bcrypt compare (cost 12), issue access JWT (15 min) in response body + opaque refresh token (32 bytes random base64url, hashed with SHA-256 before DB storage) set as `csm_refresh` httpOnly cookie
- Refresh: read refresh token from `csm_refresh` cookie, validate hash exists, not revoked, not expired → ROTATE (revoke old, issue new) → set new value as `csm_refresh` cookie, return new access token in body
- Logout: read refresh token from `csm_refresh` cookie, set `revoked_at`, clear the cookie

### Security headers (every response)

```
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Content-Security-Policy: default-src 'self'  (configure per app)
Permissions-Policy: geolocation=(), microphone=(), camera=()
```

For chat pages also: `X-Robots-Tag: noindex, nofollow`

### Rate limits

| Endpoint | Limit |
|----------|-------|
| `POST /auth/login` | 5 / 15min / IP |
| `POST /chat/verify` | 10 / min / IP |
| `POST /chat/messages` | 60 / min / session |
| `POST /sessions/:id/messages` (CSM) | 120 / min / CSM |
| Other authed | 300 / min / user |
| Other public | 60 / min / IP |

### Password policy

- Min 12 chars, uppercase + lowercase + digit + special
- bcrypt cost 12
- Reject top-1000 common passwords (use `common-passwords` npm package or a static list)

---

## ERROR RESPONSE FORMAT (RFC 7807)

All errors use `Content-Type: application/problem+json`:

```json
{
  "type": "https://api.example.com/errors/token-expired",
  "title": "Token expired",
  "status": 401,
  "detail": "The session token has expired.",
  "instance": "/v1/chat/verify",
  "code": "TOKEN_EXPIRED",
  "requestId": "req_01HX2K3M4N5P6Q7R8S9T",
  "timestamp": "2026-04-27T10:30:00.000Z",
  "errors": [{ "field": "token", "message": "Expired" }]
}
```

### Error codes

| HTTP | Code |
|------|------|
| 400 | `VALIDATION_ERROR`, `MALFORMED_REQUEST` |
| 401 | `UNAUTHENTICATED`, `INVALID_CREDENTIALS`, `INVALID_TOKEN`, `TOKEN_EXPIRED` |
| 403 | `FORBIDDEN`, `DEVICE_MISMATCH` |
| 404 | `NOT_FOUND` |
| 409 | `CONFLICT` |
| 410 | `SESSION_CLOSED` |
| 422 | `BUSINESS_RULE_VIOLATION` |
| 429 | `RATE_LIMITED` (include `Retry-After` header) |
| 500 | `INTERNAL_ERROR` (log to Sentry) |
| 503 | `SERVICE_UNAVAILABLE` |

Generate `requestId` per request (use `ulid` package), log it, include in every response (success or error).

---

## DATABASE SCHEMA

Save as `packages/db/src/schema.ts`. This is the source of truth. Run `drizzle-kit generate` after to produce migrations.

```typescript
import {
  pgTable, uuid, varchar, text, timestamp, boolean, jsonb,
  pgEnum, index, uniqueIndex, integer, inet
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

// ─── ENUMS ───
export const userRoleEnum = pgEnum('user_role', ['csm', 'admin']);
export const sessionStatusEnum = pgEnum('session_status', [
  'pending', 'active', 'csm_handling', 'closed', 'expired'
]);
// 'ai' will be added in Phase 2 via ALTER TYPE migration
export const messageSenderTypeEnum = pgEnum('message_sender_type', [
  'client', 'csm', 'system'
]);

// ─── USERS (CSMs and Admins) ───
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 255 }).notNull(),
  passwordHash: text('password_hash').notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  role: userRoleEnum('role').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true })
}, (t) => ({
  emailUniqueIdx: uniqueIndex('users_email_unique_idx')
    .on(t.email).where(sql`${t.deletedAt} IS NULL`),
  emailLowerIdx: index('users_email_lower_idx').on(sql`LOWER(${t.email})`),
  roleIdx: index('users_role_idx').on(t.role),
  activeIdx: index('users_active_idx').on(t.isActive)
}));

// ─── REFRESH TOKENS ───
export const refreshTokens = pgTable('refresh_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: varchar('token_hash', { length: 128 }).notNull(),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedReason: varchar('revoked_reason', { length: 100 }),
  rotatedToTokenId: uuid('rotated_to_token_id'),
  userAgent: text('user_agent'),
  ipAddress: inet('ip_address')
}, (t) => ({
  tokenHashUniqueIdx: uniqueIndex('refresh_tokens_token_hash_unique_idx').on(t.tokenHash),
  userIdIdx: index('refresh_tokens_user_id_idx').on(t.userId),
  expiresAtIdx: index('refresh_tokens_expires_at_idx').on(t.expiresAt)
}));

// ─── CLIENTS (end-customers) ───
export const clients = pgTable('clients', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 255 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  company: varchar('company', { length: 255 }),
  metadata: jsonb('metadata').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => ({
  emailIdx: index('clients_email_idx').on(t.email),
  emailLowerIdx: index('clients_email_lower_idx').on(sql`LOWER(${t.email})`)
}));

// ─── SESSIONS ───
export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id').notNull().references(() => clients.id, { onDelete: 'restrict' }),
  assignedCsmId: uuid('assigned_csm_id').references(() => users.id, { onDelete: 'set null' }),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  tokenHash: varchar('token_hash', { length: 128 }).notNull(),
  status: sessionStatusEnum('status').notNull().default('pending'),
  firstAccessedAt: timestamp('first_accessed_at', { withTimezone: true }),
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  closedByUserId: uuid('closed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  closedReason: varchar('closed_reason', { length: 500 }),
  metadata: jsonb('metadata').notNull().default({}),
  // Phase 2 placeholders (ignored in MVP):
  emailThreadId: varchar('email_thread_id', { length: 255 }),
  aiInterventionCount: integer('ai_intervention_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => ({
  tokenHashUniqueIdx: uniqueIndex('sessions_token_hash_unique_idx').on(t.tokenHash),
  statusIdx: index('sessions_status_idx').on(t.status),
  assignedCsmIdx: index('sessions_assigned_csm_idx').on(t.assignedCsmId),
  clientIdx: index('sessions_client_idx').on(t.clientId),
  expiresAtIdx: index('sessions_expires_at_idx').on(t.expiresAt),
  createdAtIdx: index('sessions_created_at_idx').on(t.createdAt),
  csmStatusIdx: index('sessions_csm_status_idx').on(t.assignedCsmId, t.status)
}));

// ─── SESSION DEVICES (device binding) ───
export const sessionDevices = pgTable('session_devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id').notNull(),
  userAgent: text('user_agent'),
  ipAddress: inet('ip_address'),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => ({
  // MVP: one device per session
  sessionUniqueIdx: uniqueIndex('session_devices_session_unique_idx').on(t.sessionId),
  deviceIdx: index('session_devices_device_idx').on(t.deviceId)
}));

// ─── MESSAGES ───
export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  senderType: messageSenderTypeEnum('sender_type').notNull(),
  senderId: uuid('sender_id'),  // users.id for csm; null otherwise
  content: text('content').notNull(),
  clientMessageId: uuid('client_message_id'),  // idempotency
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  readAt: timestamp('read_at', { withTimezone: true }),
  // Phase 2: messages.metadata will hold AI provenance — { model, intent, blocked, tokensUsed }
  // Phase 1: always {}
  metadata: jsonb('metadata').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => ({
  sessionCreatedIdx: index('messages_session_created_idx').on(t.sessionId, t.createdAt),
  sessionClientMsgUniqueIdx: uniqueIndex('messages_session_client_msg_unique_idx')
    .on(t.sessionId, t.clientMessageId)
    .where(sql`${t.clientMessageId} IS NOT NULL`),
  senderIdx: index('messages_sender_idx').on(t.senderType, t.senderId)
}));

// ─── AUDIT LOG ───
export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  actorType: varchar('actor_type', { length: 20 }).notNull(),  // 'user' | 'client' | 'system'
  actorId: uuid('actor_id'),
  action: varchar('action', { length: 100 }).notNull(),
  targetType: varchar('target_type', { length: 50 }),
  targetId: uuid('target_id'),
  metadata: jsonb('metadata').notNull().default({}),
  ipAddress: inet('ip_address'),
  userAgent: text('user_agent'),
  requestId: varchar('request_id', { length: 50 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => ({
  actorIdx: index('audit_log_actor_idx').on(t.actorType, t.actorId),
  targetIdx: index('audit_log_target_idx').on(t.targetType, t.targetId),
  actionIdx: index('audit_log_action_idx').on(t.action),
  createdAtIdx: index('audit_log_created_at_idx').on(t.createdAt)
}));

// ─── RELATIONS ───
export const usersRelations = relations(users, ({ many }) => ({
  refreshTokens: many(refreshTokens),
  assignedSessions: many(sessions, { relationName: 'assignedCsm' }),
  createdSessions: many(sessions, { relationName: 'createdBy' })
}));

export const refreshTokensRelations = relations(refreshTokens, ({ one }) => ({
  user: one(users, { fields: [refreshTokens.userId], references: [users.id] })
}));

export const clientsRelations = relations(clients, ({ many }) => ({
  sessions: many(sessions)
}));

export const sessionsRelations = relations(sessions, ({ one, many }) => ({
  client: one(clients, { fields: [sessions.clientId], references: [clients.id] }),
  assignedCsm: one(users, {
    fields: [sessions.assignedCsmId], references: [users.id], relationName: 'assignedCsm'
  }),
  createdBy: one(users, {
    fields: [sessions.createdByUserId], references: [users.id], relationName: 'createdBy'
  }),
  closedBy: one(users, { fields: [sessions.closedByUserId], references: [users.id] }),
  messages: many(messages),
  devices: many(sessionDevices)
}));

export const sessionDevicesRelations = relations(sessionDevices, ({ one }) => ({
  session: one(sessions, { fields: [sessionDevices.sessionId], references: [sessions.id] })
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  session: one(sessions, { fields: [messages.sessionId], references: [sessions.id] }),
  sender: one(users, { fields: [messages.senderId], references: [users.id] })
}));
```

Add `updated_at` trigger as a follow-up custom migration:

```sql
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER clients_set_updated_at BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER sessions_set_updated_at BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

---

## API ENDPOINTS

All routes prefixed with `/v1`. Define each as a Fastify route with Zod validation via `fastify-type-provider-zod`.

### Pagination — applies to ALL list endpoints

Every list endpoint (`GET /v1/sessions`, `GET /v1/users`, `GET /v1/clients`, `GET /v1/sessions/:id/messages`, `GET /v1/chat/messages`) MUST enforce these limits via Zod validation:

```ts
page: z.coerce.number().int().min(1).default(1)
limit: z.coerce.number().int().min(1).max(100).default(20)
```

Exception: message list endpoints (`GET /v1/sessions/:id/messages`, `GET /v1/chat/messages`) may use `max(200)` for the limit since older messages are common to load in a single batch.

Reject (400 `VALIDATION_ERROR`) any request exceeding these limits. Do not silently clamp.

### Auth

> **Auth contract — refresh token transport (decided 2026-04-27)**
>
> Refresh tokens are NEVER returned in JSON. They live only in an httpOnly cookie named `csm_refresh` set by the server. Cookie attributes: `HttpOnly; Secure (prod only); SameSite=Lax; Path=/v1/auth; Max-Age=2592000` (30 days).

- `POST /v1/auth/login` — body `{ email, password }` → `{ accessToken, expiresIn, user }`. On success, server sets `csm_refresh` httpOnly cookie containing the refresh token.
- `POST /v1/auth/refresh` — no body. Server reads refresh token from `csm_refresh` cookie, rotates it (revoke old → issue new), sets the new value as a new `csm_refresh` cookie, returns `{ accessToken, expiresIn }`.
- `POST /v1/auth/logout` — no body. Server reads refresh token from `csm_refresh` cookie, revokes it, clears the cookie. Returns 204.
- `GET /v1/auth/me` — authed → current user

### Sessions (CSM/admin authed)

> **`expiresInDays` (decided 2026-04-27)**: optional in `POST /v1/sessions`. Defaults to `7`. Must be an integer in `[1, 30]`. Out-of-range values → 400 `VALIDATION_ERROR`.

- `POST /v1/sessions` — body `{ clientEmail, clientName, clientCompany?, assignedCsmId?, expiresInDays?, metadata? }` → `{ session, chatUrl, expiresAt }`
- `GET /v1/sessions` — query `status[]`, `assignedCsmId`, `clientId`, `from`, `to`, `page`, `limit`
- `GET /v1/sessions/:sessionId` — detailed (includes client, assigned CSM, messageCount)
- `PATCH /v1/sessions/:sessionId` — body `{ assignedCsmId?, metadata? }`
- `POST /v1/sessions/:sessionId/close` — body `{ reason? }`

### Messages — CSM (CSM/admin authed)
- `GET /v1/sessions/:sessionId/messages` — query `before`, `limit` → `{ items, hasMore, oldestCreatedAt }`
- `POST /v1/sessions/:sessionId/messages` — body `{ content, clientMessageId }` → message (REST fallback for WS)

### Chat — Client (token auth)
- `POST /v1/chat/verify` — body `{ token }` → sets cookie, returns `{ sessionId, clientName, csmName, status, sessionJwt, wsToken, expiresAt }`
- `GET /v1/chat/session` — auth: ChatJwtAuth bearer → current session info + csmOnline status
- `GET /v1/chat/messages` — auth: ChatJwtAuth → `{ items, hasMore }`
- `POST /v1/chat/messages` — auth: ChatJwtAuth, body `{ content, clientMessageId }`

### Users (admin only)
- `GET /v1/users` — query `role`, `page`, `limit`
- `POST /v1/users` — body `{ email, name, role, password }`
- `GET /v1/users/:userId`
- `PATCH /v1/users/:userId` — body `{ name?, role?, isActive?, password? }`
- `DELETE /v1/users/:userId` — soft delete

### Clients (CSM/admin authed)
- `GET /v1/clients` — query `search`, `page`, `limit`
- `GET /v1/clients/:clientId`

### Health (no auth)
- `GET /health` — `{ status: 'ok', uptime, version }`
- `GET /health/ready` — checks DB connectivity, 200 or 503

---

## WEBSOCKET PROTOCOL

Socket.IO 4.x. Single namespace `/chat`. Two connection types: client and CSM.

### Client connection

```js
io('/chat', {
  auth: { type: 'client', wsToken: '<from /chat/verify>' }
});
```

### CSM connection

```js
io('/chat', {
  auth: { type: 'csm', accessToken: '<JWT from /auth/login>' }
});
```

### Server handshake validation

1. Validate `wsToken` (single-use, 60s TTL, in-memory `Map` for MVP) OR `accessToken` JWT
2. Attach `socket.data = { identityType, sessionId?, userId? }`
3. Auto-join rooms:
   - Client → `socket.join('session:' + sessionId)`
   - CSM → `socket.join('csm:' + userId)` AND for each active session assigned, also join `session:<id>`

### Events

**Client → Server:**
- `message:send` `{ content, clientMessageId }` → ack `{ ok: true, message }` or `{ ok: false, error }`
- `presence:ping` `{}` → ack `{ ok: true }` (every 30s)

**Server → room `session:<id>`:**
- `message:new` `Message` (after persist)
- `session:status` `{ status, csmName? }`
- `presence:csm` `{ online, lastSeenAt }`

**CSM → Server:**
- `message:send` `{ sessionId, content, clientMessageId }`
- `session:join` `{ sessionId }` (for sessions not pre-assigned)
- `presence:ping` `{}`

### Reliability rules

- **Persist before broadcast.** Wrap message insert + room emit. Insert returns → emit → ack to sender. Never emit without persisting.
- **Idempotency** by `clientMessageId` — if a duplicate insert is attempted, return the existing message instead of erroring.
- **Reconnection replay**: client sends `auth.lastSeenMessageId` on reconnect; server replays messages with `created_at > lastSeenAt` for that session (cap 200).
- **Backoff**: client uses exp backoff with jitter (250ms base, 30s cap, 2× multiplier, 0.3 jitter).
- **Heartbeat**: Socket.IO defaults (25s ping interval, 60s timeout) are fine.

### Limits
- 8 KB max payload per event
- 5 max concurrent connections per IP
- 10 events per socket per second (rate-limited server-side)

---

## ENVIRONMENT VARIABLES

`.env.example` (commit this; never commit `.env.local`):

```bash
# ─── Core ───
NODE_ENV=development
PORT=4000
LOG_LEVEL=info
APP_BASE_URL=http://localhost:3000
API_BASE_URL=http://localhost:4000

# ─── Database ───
DATABASE_URL=postgres://user:pass@host:5432/csm_chat
DATABASE_POOL_MAX=10
DATABASE_POOL_IDLE_TIMEOUT_MS=30000

# ─── JWT Secrets (32-byte random base64; use `openssl rand -base64 32`) ───
JWT_ACCESS_SECRET=
JWT_ACCESS_TTL_SEC=900
JWT_REFRESH_TTL_DAYS=30
SESSION_TOKEN_SECRET=
SESSION_JWT_SECRET=
SESSION_JWT_TTL_SEC=3600

# ─── Cookies ───
COOKIE_SECURE=true
COOKIE_SAMESITE=lax
COOKIE_DOMAIN=

# ─── CORS ───
CORS_ORIGINS=https://app.example.com,http://localhost:3000

# ─── Observability ───
SENTRY_DSN_API=
SENTRY_DSN_WEB=
SENTRY_ENVIRONMENT=development

# ─── WebSocket ───
WS_PING_INTERVAL_MS=25000
WS_PING_TIMEOUT_MS=60000

# ─── Frontend (Next.js) ───
NEXT_PUBLIC_API_URL=http://localhost:4000
NEXT_PUBLIC_WS_URL=ws://localhost:4000
NEXT_PUBLIC_SENTRY_DSN=

# ─── Phase 2 (DO NOT USE IN PHASE 1; defined here so .env.example is final) ───
# GEMINI_API_KEY=
# TWILIO_ACCOUNT_SID=
# TWILIO_AUTH_TOKEN=
# TWILIO_WHATSAPP_FROM=
```

**Validation:** all required vars must pass through a Zod schema in `apps/api/src/config.ts`. The app fails to start if any required var is missing. Phase 2 vars are NOT in the Zod schema yet.

---

## BUILD ORDER — STEPS 1 THROUGH 14

**STOP after each step.** Report what was done. Wait for confirmation before continuing.

### STEP 1 — Repository Scaffolding

Set up:
- pnpm workspace with `apps/web`, `apps/api`, `packages/db`, `packages/shared`
- TypeScript with `strict: true` everywhere
- ESLint + Prettier (shared config in root)
- Husky pre-commit hook running `pnpm lint && pnpm typecheck`
- Turborepo `turbo.json` with `dev`, `build`, `test`, `lint` pipelines
- GitHub Actions workflow `.github/workflows/ci.yml` running typecheck + lint + test on PR
- Initial `README.md` with setup instructions
- `.env.example` with the variables listed above
- `.gitignore` covering `node_modules`, `.env*`, `dist`, `.next`, etc.

**Stop. Report:** repo tree, package versions installed, `pnpm install` succeeds, CI workflow file ready.

### STEP 2 — Database Package

In `packages/db/`:
- Drizzle schema as specified above (paste verbatim, do not modify)
- `drizzle.config.ts` pointing to `DATABASE_URL`
- `src/client.ts` exporting a Drizzle client factory using `pg` Pool
- Generate initial migration with `drizzle-kit generate`
- Add the `set_updated_at` SQL trigger as a custom follow-up migration file
- `src/seed.ts` script that creates: 1 admin (`admin@example.com` / `Admin123!@#456`), 2 CSMs (`csm1@example.com`, `csm2@example.com`, same password — print to console "CHANGE THESE BEFORE PRODUCTION")
- Set up local Postgres via `docker-compose.yml` for development

**Stop. Report:** schema applied, all tables visible via `\dt`, seed runs cleanly, can query users.

### STEP 3 — Shared Package

In `packages/shared/`:
- Zod schemas for every API request/response type listed in this document
- Type exports inferred from Zod schemas (`z.infer<typeof XSchema>`)
- Error code constants matching the taxonomy in §"Error codes"
- A `Problem` helper class implementing RFC 7807 with `requestId`, `code`, `errors[]`
- Export a `createProblem(code, opts)` factory

**Stop. Report:** `pnpm typecheck` passes in shared package.

### STEP 4 — API Foundation

In `apps/api/`:
- Fastify server with these plugins (in order):
  1. `@fastify/cors` (using `CORS_ORIGINS` env)
  2. `@fastify/helmet` for security headers
  3. `@fastify/cookie` (for device cookie)
  4. Custom `request-id` plugin (generates ULID, attaches to `req.id`, sets `X-Request-Id` response header)
  5. `@fastify/rate-limit` with limits per §"Rate limits"
  6. Pino logger configured to JSON output, includes `requestId` in every log line
  7. `fastify-type-provider-zod` for route validation
  8. Custom error handler converting all errors to RFC 7807 Problem responses
- Config loader in `src/config.ts` — Zod schema for env vars, fail-fast on missing required vars
- Sentry initialization (only if `SENTRY_DSN_API` set)
- Health routes:
  - `GET /health` returns `{ status: 'ok', uptime: process.uptime(), version: pkg.version }`
  - `GET /health/ready` runs `SELECT 1` against DB; returns 200 or 503
- Server boots on `PORT`, logs startup line including version

**Stop. Report:** `curl http://localhost:4000/health` returns OK; `/health/ready` returns 200 when DB up, 503 when DB down (test by stopping docker compose).

### STEP 5 — Authentication

In `apps/api/src/`:
- `services/auth.service.ts`:
  - `register(email, password, name, role)` — admin-only, bcrypt hash cost 12, validates password policy
  - `login(email, password)` — bcrypt compare, increment `failed_login_attempts` on failure, lock account after 5 failures for 15 min, issue access JWT (15 min) + refresh token (32-byte random, stored as SHA-256 hash)
  - `refresh(refreshToken)` — validate hash, not revoked, not expired; rotate (revoke old, create new); return new pair
  - `logout(refreshToken)` — set `revoked_at` and `revoked_reason='user_logout'`
  - `me(userId)` — return user (without `password_hash`)
- `lib/jwt.ts` — uses `jose` library, two separate secrets for access vs session JWTs
- `plugins/auth.ts` — Fastify plugin that decorates `req.user` based on `Authorization: Bearer` header; throws 401 `UNAUTHENTICATED` if missing on protected routes
- Routes for `/v1/auth/*` per §"API Endpoints" (route handlers read/write the `csm_refresh` cookie; service-layer functions still take refresh-token strings)
- Integration tests for: login success, login failure, account lock after 5 failures, refresh rotation, logout revocation, refreshing a revoked token returns 401

**Stop. Report:** all 4 auth endpoints work via curl, all integration tests pass.

### STEP 6 — User Management (admin only)

- `services/user.service.ts` with CRUD methods
- Routes for `/v1/users/*` per spec
- Role-based access: admin can do all; CSM can only `GET /v1/users/:userId` for self
- Soft delete sets `deleted_at`; user no longer appears in lists or login
- Tests: admin creates CSM, admin updates role, admin deactivates, soft-deleted user cannot login

**Stop. Report:** endpoints work, tests pass.

### STEP 7 — Clients & Session Creation (CSM side)

- `services/client.service.ts`:
  - `findOrCreateByEmail({ email, name, company, metadata })` — case-insensitive email match using `LOWER(email)` index
  - `list({ search, page, limit })` — ILIKE on email or name
  - `getById(id)`
- `services/session.service.ts`:
  - `create({ clientId, assignedCsmId, createdByUserId, expiresInDays, metadata })`:
    1. Default `expiresInDays` to 7 if omitted; reject < 1 or > 30 with 400 `VALIDATION_ERROR` (validation lives at the route boundary, not the service)
    2. Generate session UUID
    3. Sign JWT `{ sid: sessionId, exp, iat, ver: 1 }` with `SESSION_TOKEN_SECRET` using `jose`
    4. Compute SHA-256 hash of token
    5. Insert into sessions table with `token_hash`
    6. Return `{ session, chatUrl: ${APP_BASE_URL}/c/${token}, expiresAt }`
  - `list(...)`, `getById(...)`, `update(...)`, `close(id, reason, closedByUserId)`
- Routes for `/v1/sessions/*` and `/v1/clients/*`
- Tests: CSM creates session, retrieves chat URL, lists sessions filtered by status, closes session

**Stop. Report:** can create a session via curl, get the chat URL, see the row in DB.

### STEP 8 — Client Chat Verify + REST Messaging

- `services/token.service.ts`:
  - `verifySessionToken(token)` — JWT verify → look up `token_hash` in sessions → check status → return session or throw appropriate error
  - `issueSessionJwt(sessionId, deviceId)` — short-lived JWT
  - `issueWsToken(sessionId, deviceId)` — random 32-byte token, store in in-memory `Map` with 60s TTL
  - `consumeWsToken(token)` — single-use, returns `{ sessionId, deviceId }` or null
- `services/message.service.ts`:
  - `send({ sessionId, senderType, senderId, content, clientMessageId })` — inserts with idempotency on `(session_id, client_message_id)`; if duplicate, return existing message; updates `sessions.last_message_at`
  - `list({ sessionId, before, limit })` — paginated by `created_at` cursor
- `routes/chat/verify.ts` — implements full flow from §"Client session flow"
- `plugins/chat-auth.ts` — validates session JWT from Authorization header
- Routes for `/v1/chat/*` and `/v1/sessions/:id/messages`
- Tests:
  - First-time verify creates device row, sets cookie, returns tokens
  - Second visit with same cookie succeeds
  - Visit without cookie when device row exists → 403 DEVICE_MISMATCH
  - Verify on closed session → 410
  - Verify on expired token → 401
  - Idempotent message send: same `clientMessageId` returns same message
  - Message send to closed session → 410

**Stop. Report:** full REST chat flow works end-to-end; can simulate "client clicks link → verify → send messages → CSM lists messages" via curl.

### STEP 9 — WebSocket Layer

- Attach Socket.IO to Fastify server (single instance, no Redis)
- `socket/auth.ts` — handshake middleware validates `auth.type` and corresponding token
- `socket/handlers.ts` — registers event handlers per §"WebSocket Protocol"
- Persist-before-broadcast: wrap message insert + emit; if insert fails, ack `{ ok: false }` and don't emit
- Reconnection replay using `auth.lastSeenMessageId`
- Heartbeat tracking — update `users.last_seen_at` every 30s for connected CSMs
- E2E test using `socket.io-client`:
  - Two clients connect (one as client, one as CSM)
  - Client sends message → CSM receives `message:new` within 100ms
  - CSM sends message → client receives
  - CSM disconnects → client gets `presence:csm { online: false }` after 60s
  - Client reconnects with `lastSeenMessageId` → gets missed messages

**Stop. Report:** real-time chat works between two browser tabs.

### STEP 10 — Frontend: CSM Dashboard

In `apps/web/`:
- Auth flow: login page → store accessToken in memory (Zustand or React Context, NOT localStorage). Refresh token lives only in the `csm_refresh` httpOnly cookie set by the API on login; the browser never reads or stores it manually. Use `credentials: 'include'` on `/v1/auth/refresh` and `/v1/auth/logout` calls.
- Auto-refresh access token before expiry (interceptor in API client)
- Sessions list page (`/sessions`):
  - Filters: status (multi-select), mine vs all, date range
  - Table: client name/email, status, last message time, assigned CSM
  - Pagination
- Session detail page (`/sessions/[id]`):
  - Message history (paginated, infinite scroll backward)
  - Composer at bottom (textarea + send)
  - Connect Socket.IO on mount; disconnect on unmount
  - Show `presence:csm` indicator
  - Close session button with confirmation
- Create session page/modal:
  - Form: client email, name, optional company, expiry (default 7 days)
  - On submit: POST `/v1/sessions`, show generated chat URL with copy button
- Mobile-responsive throughout (test at 375px width)
- shadcn/ui components: Button, Input, Dialog, Table, Toast

**Stop. Report:** CSM can log in, see their sessions, click into one, send/receive messages in real time.

### STEP 11 — Frontend: Client Chat

- Route `/c/[token]/page.tsx`:
  - On mount: POST `/v1/chat/verify` with token from URL params
  - On 200: store sessionJwt in memory, render chat UI, connect Socket.IO with wsToken
  - On 401/403/410: render appropriate error page (expired, device mismatch, closed)
- Chat UI:
  - Header with CSM name + online indicator
  - Message list (paginated, scroll-up to load more)
  - Composer: textarea + send button (Enter to send, Shift+Enter for newline)
  - Status banner: "CSM offline — your message will be answered soon"
- Mobile-first design (this is most of the traffic)
- Reconnection UI: subtle banner during reconnect attempts
- Generate `clientMessageId` (UUID v4) for each outgoing message
- Track `lastSeenMessageId` for replay on reconnect

**Stop. Report:** client can open the link in mobile browser, send messages, see CSM replies in real time. Test on actual phone.

### STEP 12 — Audit Logging

- Middleware that wraps these actions and writes to `audit_log`:
  - `auth.login` (success and failure)
  - `auth.logout`
  - `user.create`, `user.update`, `user.delete`
  - `session.create`, `session.close`, `session.update`
  - `chat.verify` (success only — failures already in rate limit logs)
- Do NOT log every message (too noisy)
- All log rows include `request_id`, `ip_address`, `user_agent`, `actor_type`, `actor_id`

**Stop. Report:** verified rows appearing in `audit_log` after each action.

### STEP 13 — Hardening

- Verify all rate limits per §"Rate limits" with k6 or autocannon
- Verify all security headers via [securityheaders.com](https://securityheaders.com) on staging deploy
- Run OWASP ZAP automated scan in CI (block deploy on Highs)
- Load test with k6: 50 concurrent client sessions, 5 messages/sec sustained, 30 min — verify no memory leaks, p95 latency < 400ms
- Verify Sentry integration: throw a test error in API and frontend, see them in dashboard with `requestId`
- Verify graceful shutdown: SIGTERM should drain WebSocket connections, finish in-flight requests, close DB pool

**Stop. Report:** all checks pass, load test results.

### STEP 14 — Deployment

- Railway:
  - Create project with API service + managed Postgres (or external Supabase URL)
  - Set all env vars from `.env.example`
  - Deploy from `main` branch
- Vercel:
  - Create project for `apps/web`
  - Set `NEXT_PUBLIC_*` env vars
  - Configure build command for monorepo (`pnpm --filter web build`)
- GitHub Actions:
  - On merge to `main`: run tests → if pass, deploy to staging
  - Manual approval gate to promote staging → production
- Post-deploy smoke test script (curl-based) that runs after each deploy:
  - `/health` returns 200
  - `/health/ready` returns 200
  - Login as seed admin works
  - Create session works
  - Verify session works

**Stop. Report:** staging URL working end-to-end, production deploy procedure documented.

---

## CONVENTIONS

### Commits
Conventional Commits format. Examples:
- `feat(api): add session creation endpoint`
- `fix(web): handle expired token on chat verify`
- `chore(db): add session_devices table`
- `test(api): add auth integration tests`

### Branches
- `main` — protected, deploys to staging on merge
- `feat/<scope>-<short-description>` — feature branches
- PR required, CI must pass, one approval (or self if solo)

### Code style
- TypeScript strict mode, no `any` without comment justification
- Zod for all external boundaries (HTTP, WS, env)
- Drizzle queries: prefer typed builder over raw SQL except for complex aggregates
- No `console.log` in committed code — use Pino logger
- Async/await everywhere, no `.then()` chains

### Tests
- Unit tests next to code: `auth.service.test.ts` next to `auth.service.ts`
- Integration tests in `apps/api/tests/integration/`
- E2E tests in `apps/web/e2e/` using Playwright
- Coverage targets: 70% line on services, 100% on security-critical paths (token verification, password handling, rate limit logic)

---

## WHEN YOU GET STUCK

If you hit something genuinely ambiguous, stop and ask. Examples:
- Schema field meaning unclear
- Behavior on an edge case not covered (e.g., what happens if a CSM is deleted while a session is assigned to them)
- Library choice within a category I didn't lock (e.g., which UUID library)
- Whether to use a feature I didn't mention (e.g., HTTP/2)

Things you should NOT ask about — just decide and document in commit:
- File naming within a folder
- Internal function organization
- Test structure
- Import order

---

## END OF PHASE 1 BUILD INSTRUCTIONS

When ready to start, confirm you've read this document, list any clarifying questions, then begin Step 1.

**Reminder: `PHASE2_AI_DESIGN.md` exists in this repo. DO NOT read or implement anything from it during Phase 1.**
