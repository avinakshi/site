import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  jsonb,
  pgEnum,
  index,
  uniqueIndex,
  integer,
  inet,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

// ─── ENUMS ───
export const userRoleEnum = pgEnum('user_role', ['csm', 'admin']);
export const sessionStatusEnum = pgEnum('session_status', [
  'pending',
  'active',
  'csm_handling',
  'closed',
  'expired',
]);
// 'ai' will be added in Phase 2 via ALTER TYPE migration
export const messageSenderTypeEnum = pgEnum('message_sender_type', ['client', 'csm', 'system']);

// ─── USERS (CSMs and Admins) ───
export const users = pgTable(
  'users',
  {
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
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    emailUniqueIdx: uniqueIndex('users_email_unique_idx')
      .on(t.email)
      .where(sql`${t.deletedAt} IS NULL`),
    emailLowerIdx: index('users_email_lower_idx').on(sql`LOWER(${t.email})`),
    roleIdx: index('users_role_idx').on(t.role),
    activeIdx: index('users_active_idx').on(t.isActive),
  }),
);

// ─── REFRESH TOKENS ───
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 128 }).notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: varchar('revoked_reason', { length: 100 }),
    rotatedToTokenId: uuid('rotated_to_token_id'),
    userAgent: text('user_agent'),
    ipAddress: inet('ip_address'),
  },
  (t) => ({
    tokenHashUniqueIdx: uniqueIndex('refresh_tokens_token_hash_unique_idx').on(t.tokenHash),
    userIdIdx: index('refresh_tokens_user_id_idx').on(t.userId),
    expiresAtIdx: index('refresh_tokens_expires_at_idx').on(t.expiresAt),
  }),
);

// ─── CLIENTS (end-customers) ───
export const clients = pgTable(
  'clients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: varchar('email', { length: 255 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    company: varchar('company', { length: 255 }),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailIdx: index('clients_email_idx').on(t.email),
    emailLowerIdx: index('clients_email_lower_idx').on(sql`LOWER(${t.email})`),
  }),
);

// ─── SESSIONS ───
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    assignedCsmId: uuid('assigned_csm_id').references(() => users.id, { onDelete: 'set null' }),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    tokenHash: varchar('token_hash', { length: 128 }).notNull(),
    status: sessionStatusEnum('status').notNull().default('pending'),
    firstAccessedAt: timestamp('first_accessed_at', { withTimezone: true }),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedByUserId: uuid('closed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    closedReason: varchar('closed_reason', { length: 500 }),
    metadata: jsonb('metadata').notNull().default({}),
    // Phase 2 placeholders (ignored in MVP):
    emailThreadId: varchar('email_thread_id', { length: 255 }),
    aiInterventionCount: integer('ai_intervention_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tokenHashUniqueIdx: uniqueIndex('sessions_token_hash_unique_idx').on(t.tokenHash),
    statusIdx: index('sessions_status_idx').on(t.status),
    assignedCsmIdx: index('sessions_assigned_csm_idx').on(t.assignedCsmId),
    clientIdx: index('sessions_client_idx').on(t.clientId),
    expiresAtIdx: index('sessions_expires_at_idx').on(t.expiresAt),
    createdAtIdx: index('sessions_created_at_idx').on(t.createdAt),
    csmStatusIdx: index('sessions_csm_status_idx').on(t.assignedCsmId, t.status),
  }),
);

// ─── SESSION DEVICES (device binding) ───
export const sessionDevices = pgTable(
  'session_devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').notNull(),
    userAgent: text('user_agent'),
    ipAddress: inet('ip_address'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // MVP: one device per session
    sessionUniqueIdx: uniqueIndex('session_devices_session_unique_idx').on(t.sessionId),
    deviceIdx: index('session_devices_device_idx').on(t.deviceId),
  }),
);

// ─── MESSAGES ───
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    senderType: messageSenderTypeEnum('sender_type').notNull(),
    senderId: uuid('sender_id'), // users.id for csm; null otherwise
    content: text('content').notNull(),
    clientMessageId: uuid('client_message_id'), // idempotency
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    readAt: timestamp('read_at', { withTimezone: true }),
    // Phase 2: messages.metadata holds AI provenance — { model, intent, blocked, tokensUsed }
    // Phase 1: always {}
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sessionCreatedIdx: index('messages_session_created_idx').on(t.sessionId, t.createdAt),
    sessionClientMsgUniqueIdx: uniqueIndex('messages_session_client_msg_unique_idx')
      .on(t.sessionId, t.clientMessageId)
      .where(sql`${t.clientMessageId} IS NOT NULL`),
    senderIdx: index('messages_sender_idx').on(t.senderType, t.senderId),
  }),
);

// ─── AUDIT LOG ───
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorType: varchar('actor_type', { length: 20 }).notNull(), // 'user' | 'client' | 'system'
    actorId: uuid('actor_id'),
    action: varchar('action', { length: 100 }).notNull(),
    targetType: varchar('target_type', { length: 50 }),
    targetId: uuid('target_id'),
    metadata: jsonb('metadata').notNull().default({}),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    requestId: varchar('request_id', { length: 50 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    actorIdx: index('audit_log_actor_idx').on(t.actorType, t.actorId),
    targetIdx: index('audit_log_target_idx').on(t.targetType, t.targetId),
    actionIdx: index('audit_log_action_idx').on(t.action),
    createdAtIdx: index('audit_log_created_at_idx').on(t.createdAt),
  }),
);

// ─── RELATIONS ───
export const usersRelations = relations(users, ({ many }) => ({
  refreshTokens: many(refreshTokens),
  assignedSessions: many(sessions, { relationName: 'assignedCsm' }),
  createdSessions: many(sessions, { relationName: 'createdBy' }),
}));

export const refreshTokensRelations = relations(refreshTokens, ({ one }) => ({
  user: one(users, { fields: [refreshTokens.userId], references: [users.id] }),
}));

export const clientsRelations = relations(clients, ({ many }) => ({
  sessions: many(sessions),
}));

export const sessionsRelations = relations(sessions, ({ one, many }) => ({
  client: one(clients, { fields: [sessions.clientId], references: [clients.id] }),
  assignedCsm: one(users, {
    fields: [sessions.assignedCsmId],
    references: [users.id],
    relationName: 'assignedCsm',
  }),
  createdBy: one(users, {
    fields: [sessions.createdByUserId],
    references: [users.id],
    relationName: 'createdBy',
  }),
  closedBy: one(users, { fields: [sessions.closedByUserId], references: [users.id] }),
  messages: many(messages),
  devices: many(sessionDevices),
}));

export const sessionDevicesRelations = relations(sessionDevices, ({ one }) => ({
  session: one(sessions, { fields: [sessionDevices.sessionId], references: [sessions.id] }),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  session: one(sessions, { fields: [messages.sessionId], references: [sessions.id] }),
  sender: one(users, { fields: [messages.senderId], references: [users.id] }),
}));
