# Phase 2 AI Design — LOCKED
## AI-Assisted Customer Success Chat System

> **Status:** Locked design. Do not implement until Phase 1 is shipped, stable, and running real conversations for at least 2 weeks.
>
> **For Claude Code:** If you are reading this during Phase 1, **stop and go back to `CLAUDE.md`**. This document is for Phase 2 only.
>
> **Why this document exists now:** AI architecture decisions are easy to get wrong and expensive to change later. Locking the design while context is fresh prevents drift between "what we said we'd build" and "what we ended up building."

---

## TABLE OF CONTENTS

1. Design Philosophy
2. The Three-Layer Architecture
3. Provider Abstraction (Why Not "Just Gemini")
4. Intent Classification Layer (with PII Redaction)
5. Generation Layer (Gemini 2.5 Flash) — Timeouts & Retry
6. Output Guardrail Layer
7. Cost Controls & Circuit Breakers
8. Schema Additions (No Migrations Required)
9. Service Layer Design
10. WebSocket & UX Integration
11. Prompt Versioning & Eval Framework
12. Failure Modes & Fallbacks
13. Phase 2.0 (Lean Release) vs Phase 2.1 (Full)
14. Implementation Order
15. Open Questions Before Phase 2 Starts

---

## 1. Design Philosophy

Three principles drive every decision in this document:

**1. The LLM is the dumbest part of the system.** Smart routing, deterministic rules, and explicit guardrails do the heavy lifting. The model only generates prose for queries we've already classified as safe to answer.

**2. Provider-agnostic by default.** Gemini is the launch provider. The system must run on Claude, GPT, or a self-hosted Llama with one config change. Vendor lock-in on LLM providers is a strategic mistake — capabilities and pricing shift quarterly.

**3. Fail closed, not open.** When in doubt, escalate to human. A canned "I'll check and get back to you" is always safer than a confident wrong answer. We optimize for *not embarrassing the CSM*, not for AI engagement metrics.

---

## 2. The Three-Layer Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    CLIENT MESSAGE ARRIVES                    │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
              ┌────────────────────────┐
              │   PII REDACTION PASS   │  Strip emails/phones/CCs/URLs
              │   (regex + obfuscation │  before any LLM sees them.
              │    detection)          │  Original message persisted
              │                        │  to DB; redacted version sent
              │                        │  to LLM only.
              └────────────┬───────────┘
                           │
                           ▼
       ┌──────────────────────────────────────┐
       │        INTENT CLASSIFICATION         │
       │   (rule-based first, LLM if needed)  │
       └──────────────────┬───────────────────┘
                          │
        ┌─────────────────┼─────────────────┬────────────────┐
        │                 │                 │                │
        ▼                 ▼                 ▼                ▼
   pricing_query   trainer_avail   complaint/urgent   general_query
        │                 │                 │                │
        ▼                 ▼                 ▼                ▼
   ┌────────┐        ┌────────┐       ┌──────────┐     ┌────────┐
   │ Canned │        │ Canned │       │ Escalate │     │   AI   │
   │ Reply  │        │ Reply  │       │ to CSM   │     │  Path  │
   └────┬───┘        └────┬───┘       └────┬─────┘     └────┬───┘
        │                 │                 │                │
        │                 │                 │                ▼
        │                 │                 │      ┌──────────────────┐
        │                 │                 │      │   RAG RETRIEVAL  │
        │                 │                 │      │ (course catalog, │
        │                 │                 │      │   FAQ via        │
        │                 │                 │      │   pgvector)      │
        │                 │                 │      └────────┬─────────┘
        │                 │                 │               │
        │                 │                 │               ▼
        │                 │                 │      ┌──────────────────┐
        │                 │                 │      │  GENERATION      │
        │                 │                 │      │  (Gemini 2.5     │
        │                 │                 │      │   Flash via      │
        │                 │                 │      │   LlmProvider)   │
        │                 │                 │      └────────┬─────────┘
        │                 │                 │               │
        │                 │                 │               ▼
        │                 │                 │      ┌──────────────────┐
        │                 │                 │      │ OUTPUT GUARDRAIL │
        │                 │                 │      │ (regex + LLM-as- │
        │                 │                 │      │  judge for       │
        │                 │                 │      │  borderline)     │
        │                 │                 │      └────────┬─────────┘
        │                 │                 │               │
        │                 │                 │      ┌────────┴─────────┐
        │                 │                 │      │                  │
        │                 │                 │      ▼                  ▼
        │                 │                 │   safe              unsafe
        │                 │                 │      │                  │
        │                 │                 │      │                  ▼
        │                 │                 │      │           ┌──────────┐
        │                 │                 │      │           │  Canned  │
        │                 │                 │      │           │ Fallback │
        │                 │                 │      │           │ + LOG    │
        │                 │                 │      │           │ INCIDENT │
        │                 │                 │      │           └────┬─────┘
        │                 │                 │      │                │
        └─────────────────┴─────────────────┴──────┴────────────────┘
                                          │
                                          ▼
                         ┌─────────────────────────────────┐
                         │   PERSIST + STREAM TO CLIENT    │
                         │   (badge: "Auto-response")      │
                         └─────────────────────────────────┘
```

Each layer is independently testable. Each layer can fail open (proceed) or closed (fall back) with explicit configuration.

---

## 3. Provider Abstraction (Why Not "Just Gemini")

### The interface

```typescript
// packages/shared/src/ai/llm-provider.ts

export interface LlmProvider {
  name: string;  // 'gemini' | 'claude' | 'openai' | 'mock'

  /**
   * Generate a response. Streaming is optional; if a provider doesn't
   * support it, the wrapper emits the full text as a single chunk.
   */
  generate(input: GenerateInput): Promise<GenerateResult>;

  /**
   * Streaming variant. Implementations that don't support streaming
   * should fall back to .generate() and yield once.
   */
  generateStream(input: GenerateInput): AsyncIterable<GenerateChunk>;

  /**
   * Lightweight intent classification. Cheap models only.
   * Implementations may use a smaller variant of the same vendor.
   */
  classify(input: ClassifyInput): Promise<ClassifyResult>;
}

export interface GenerateInput {
  systemPrompt: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxOutputTokens: number;
  temperature: number;
  stopSequences?: string[];
  metadata?: Record<string, unknown>;  // for logging
}

export interface GenerateResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  finishReason: 'stop' | 'length' | 'safety' | 'other';
  rawResponse: unknown;  // for debugging, NOT logged in prod
}
```

### The Gemini implementation

```typescript
// apps/api/src/services/ai/providers/gemini-provider.ts

import { GoogleGenerativeAI } from '@google/generative-ai';

export class GeminiProvider implements LlmProvider {
  name = 'gemini';
  private client: GoogleGenerativeAI;

  constructor(apiKey: string, private modelName = 'gemini-2.5-flash') {
    this.client = new GoogleGenerativeAI(apiKey);
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    const start = Date.now();
    const model = this.client.getGenerativeModel({
      model: this.modelName,
      systemInstruction: input.systemPrompt,
      generationConfig: {
        maxOutputTokens: input.maxOutputTokens,
        temperature: input.temperature,
        stopSequences: input.stopSequences
      }
    });

    const result = await model.generateContent({
      contents: input.messages.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }))
    });

    const response = result.response;
    return {
      text: response.text(),
      inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
      latencyMs: Date.now() - start,
      finishReason: mapFinishReason(response.candidates?.[0]?.finishReason),
      rawResponse: response
    };
  }

  // generateStream + classify implementations...
}
```

### Why this matters

Switching providers requires changing exactly one line:

```typescript
// apps/api/src/services/ai/index.ts
const provider: LlmProvider = config.AI_PROVIDER === 'claude'
  ? new ClaudeProvider(config.ANTHROPIC_API_KEY)
  : new GeminiProvider(config.GEMINI_API_KEY);
```

Everything downstream — intent classifier, guardrails, prompt templates, RAG, cost controls — is provider-independent.

This is **non-negotiable**. Do not write Gemini-specific code in services, routes, or guardrails. Gemini knowledge lives in `GeminiProvider` and nowhere else.

---

## 4. Intent Classification Layer

### Pre-step: PII Redaction (runs before classification)

The original message is persisted to `messages.content` exactly as the client sent it. A **redacted copy** is what gets passed to the classifier and generator. The original is never sent to the LLM provider.

```typescript
// apps/api/src/services/ai/pii-redactor.ts

export function redactPII(input: string): string {
  let s = input;

  // Standard email
  s = s.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[EMAIL_REDACTED]');

  // Obfuscated email: "john at gmail dot com", "john [at] gmail [dot] com"
  s = s.replace(
    /\b[\w.+-]+\s*[\[\(]?\s*(at|@)\s*[\]\)]?\s*[\w-]+\s*[\[\(]?\s*(dot|\.)\s*[\]\)]?\s*[\w]{2,}\b/gi,
    '[EMAIL_REDACTED]'
  );

  // Indian mobile: 10 digits, optional +91 / 91 / 0 prefix, optional spaces/dashes
  s = s.replace(
    /(?:\+?91[\s-]?|0)?[6-9]\d{9}\b/g,
    '[PHONE_REDACTED]'
  );
  s = s.replace(
    /\b[6-9]\d{2}[\s-]?\d{3}[\s-]?\d{4}\b/g,
    '[PHONE_REDACTED]'
  );

  // International phone (loose)
  s = s.replace(/\+\d{1,3}[\s-]?\d{6,14}\b/g, '[PHONE_REDACTED]');

  // Credit card (Luhn-like; 13–19 digits with optional separators)
  s = s.replace(/\b(?:\d[\s-]?){13,19}\b/g, '[CARD_REDACTED]');

  // URLs (clients often paste private links)
  s = s.replace(/https?:\/\/\S+/gi, '[URL_REDACTED]');
  s = s.replace(/\bwww\.\S+/gi, '[URL_REDACTED]');

  // Indian PAN: 5 letters, 4 digits, 1 letter
  s = s.replace(/\b[A-Z]{5}\d{4}[A-Z]\b/g, '[PAN_REDACTED]');

  // Aadhaar: 12 digits, often grouped 4-4-4
  s = s.replace(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, '[AADHAAR_REDACTED]');

  return s;
}
```

**Test coverage required:** the redactor must have a unit test suite of at least 30 cases covering the obfuscation patterns above. PII slipping into LLM logs is a DPDP violation.

**Important:** the LLM-side classifier and generator receive the redacted message. The audit log and `messages.content` table receive the original. This is intentional — CSMs need to see what the client actually wrote, but the LLM provider does not.

### Pass 1: Rule-based intent classification (free, instant, deterministic)

```typescript
// apps/api/src/services/ai/intent/rules.ts

const PRICING_PATTERNS = [
  /\b(price|pricing|cost|fee|rate|charge|how much|kitna|kitne)\b/i,
  /\b(quote|quotation|estimate)\b/i,
  /\b(discount|offer|deal)\b/i,
  /(₹|rs\.?|inr|usd|\$)/i,
];

const AVAILABILITY_PATTERNS = [
  /\b(available|availability|free|busy|schedule)\b/i,
  /\b(when can|next slot|next session|next batch)\b/i,
  /\b(trainer|instructor|teacher).*\b(available|free|busy|schedule)/i,
];

const URGENT_PATTERNS = [
  /\b(urgent|emergency|asap|immediately|right now)\b/i,
  /\b(complaint|complain|refund|cancel|escalate)\b/i,
  /\b(angry|upset|disappointed|frustrated)\b/i,
];

export function classifyByRules(message: string): IntentResult | null {
  const normalized = message.toLowerCase();

  if (URGENT_PATTERNS.some(p => p.test(normalized))) {
    return { intent: 'urgent_complaint', confidence: 1.0, source: 'rules' };
  }
  if (PRICING_PATTERNS.some(p => p.test(normalized))) {
    return { intent: 'pricing_query', confidence: 1.0, source: 'rules' };
  }
  if (AVAILABILITY_PATTERNS.some(p => p.test(normalized))) {
    return { intent: 'trainer_availability', confidence: 1.0, source: 'rules' };
  }

  return null;  // pass to LLM classifier
}
```

### Pass 2: LLM classifier (only if rules don't match)

Uses the same provider abstraction, with `gemini-2.5-flash-8b` (or equivalent cheapest tier). Classification prompt:

```
You are an intent classifier for a customer service chat. Classify the
client's message into EXACTLY ONE of:

- pricing_query: any mention of cost, fees, discounts, payment
- trainer_availability: any question about trainer schedules, slots, batches
- urgent_complaint: complaints, refunds, cancellations, frustration
- general_info: questions about courses, content, prerequisites, certificates
- greeting: hello, thanks, goodbye, social pleasantries
- out_of_scope: anything not related to training/courses

Respond with ONLY the category name. Nothing else.

Message: "{message}"
```

### Routing table

| Intent | Action | Why |
|--------|--------|-----|
| `pricing_query` | Canned response, log for CSM | Pricing changes; only humans confirm |
| `trainer_availability` | Canned response, log for CSM | Same as above |
| `urgent_complaint` | Immediate WhatsApp escalation, no AI reply | AI making nice noises during a complaint is worse than silence |
| `general_info` | RAG → LLM generation → guardrail | Safe to answer with grounded info |
| `greeting` | Lightweight templated response | "Hi! A team member will join shortly. Is there something specific you'd like help with?" |
| `out_of_scope` | Polite redirect | "I'm here to help with course-related questions. Could you rephrase?" |

### Confidence threshold

If LLM classifier returns confidence < 0.7 (use logprobs where available, else have model output JSON with self-rated confidence), fall back to `out_of_scope`. Never guess on low confidence.

### Canned responses

```typescript
const CANNED_RESPONSES = {
  pricing_query:
    "Thanks for your interest! Pricing depends on the specific course and batch. " +
    "I'll have someone from our team get back to you with exact details shortly.",

  trainer_availability:
    "Let me check trainer availability for you and get back with confirmed timings " +
    "shortly. Could you share your preferred timeframe in the meantime?",

  greeting:
    "Hi there! Thanks for reaching out. A team member will join shortly. " +
    "Is there something specific I can help direct you to?",

  out_of_scope:
    "I want to make sure I understand correctly. Could you rephrase your question, " +
    "or let me know if it relates to one of our courses?",
};
```

These are templates, not strings — they should support light personalization (client name, course context from `sessions.metadata`) via a templating helper.

---

## 5. Generation Layer (Gemini 2.5 Flash)

### When this runs

Only for `general_info` intent. Never for pricing, availability, or complaints.

### Inputs

1. **System prompt** (versioned, stored in `prompt_templates` table — see §11)
2. **Last 10 messages** of conversation (or fewer if shorter)
3. **RAG context**: top-3 chunks from course catalog + FAQ retrieved via pgvector embedding search on the client's message
4. **Session metadata**: course of interest, client name (NOT email or phone)

### System prompt template (v1)

```
You are a customer service assistant for {COMPANY_NAME}, a corporate training
provider. You help potential and current clients with questions about courses,
prerequisites, certifications, and general information.

YOU MUST NEVER:
- Quote or confirm prices, fees, discounts, or any monetary amounts
- Confirm trainer availability, schedules, or batch dates
- Make commitments on behalf of the company
- Discuss anything not related to training and courses
- Pretend to be human

YOU MUST ALWAYS:
- Be warm and professional
- Keep responses under 100 words
- End with a hand-off line if you're uncertain: "A team member will follow up
  shortly with specifics."
- Acknowledge that you are an automated assistant

If you don't know the answer from the provided context, say so and offer to
have a team member follow up. Do not invent information.

Provided context (use only this for facts):
{RAG_CONTEXT}

Current conversation context:
- Client name: {CLIENT_NAME}
- Topic of interest: {SESSION_METADATA_COURSE}
```

### Generation parameters

| Parameter | Value | Why |
|-----------|-------|-----|
| `temperature` | 0.3 | Slight variation, but not creative |
| `maxOutputTokens` | 300 | ~225 words; forces brevity |
| `stopSequences` | `["\n\nHuman:", "\n\nClient:"]` | Prevent role-confusion outputs |
| `topP` | 0.9 | Default, fine |

### Timeouts and retry policy

Every LLM call (classifier + generator + judge) is wrapped with strict bounds:

| Setting | Value | Notes |
|---------|-------|-------|
| Per-request timeout | 5000ms | Hard cap; abort via AbortController |
| Max retries | 1 | One retry only |
| Retry condition | 5xx response or network error only | NEVER retry 4xx (those are our bug) |
| Retry backoff | 500ms with full jitter | Don't add to total budget more than 1s |
| Total budget per AI response | 8000ms | Across all retries; if exceeded → canned fallback |
| Streaming first-token timeout | 3000ms | If no first token in 3s, abort and use canned fallback |

If timeout fires:
- Increment circuit breaker error counter
- Log incident with `incidentType: 'timeout'`
- Return canned safe fallback to client
- Do NOT retry beyond budget

### Streaming

Stream tokens to client via Socket.IO `message:ai_streaming` events for perceived latency. Persist the final message after streaming completes.

---

## 6. Output Guardrail Layer

Three checks, in order:

### Check 1: Regex blocklist (fast, deterministic)

```typescript
const FORBIDDEN_PATTERNS = [
  // Currency / pricing
  /(₹|rs\.?\s*\d|inr\s*\d|\$\s*\d|usd\s*\d|eur\s*\d)/i,
  /\b\d{1,3}(,\d{3})*(\.\d+)?\s*(rupees|dollars|euros|inr|usd)\b/i,

  // Commitment language
  /\b(yes,?\s+(we|i)\s+(can|will))\b/i,
  /\b(confirmed|guaranteed|promised|reserved)\b/i,
  /\b(available|booked)\s+(on|for|at)\b/i,

  // Date/time specifics that imply availability
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(at|from|to)\s+\d/i,
  /\b\d{1,2}(:\d{2})?\s*(am|pm)\b/i,
];
```

### Check 2: Forbidden topic check (LLM-as-judge, only for borderline)

If regex passes but the response is over 50 words and on topics adjacent to pricing/availability, run a quick judge prompt:

```
Does this response from a customer service AI confirm pricing, availability,
trainer schedules, or make any commitment on behalf of the company?

Response: "{ai_response}"

Answer ONLY: YES or NO.
```

If YES → drop response.

### Check 3: Length and safety

- If response > 500 chars → truncate and append "..." + canned hand-off line
- If response is empty or contains only whitespace → use canned fallback

### When guardrail triggers

```typescript
// apps/api/src/services/ai/guardrail.ts

export async function applyGuardrail(
  response: string,
  context: GuardrailContext
): Promise<GuardrailResult> {
  // Check 1
  const regexHit = FORBIDDEN_PATTERNS.find(p => p.test(response));
  if (regexHit) {
    await logIncident({
      sessionId: context.sessionId,
      type: 'regex_block',
      pattern: regexHit.source,
      response,
    });
    return { safe: false, fallback: SAFE_FALLBACK };
  }

  // Check 2 (only if needed)
  if (response.length > 200 && context.intent === 'general_info') {
    const verdict = await llmJudge(response);
    if (verdict === 'YES') {
      await logIncident({ /* ... */ });
      return { safe: false, fallback: SAFE_FALLBACK };
    }
  }

  // Check 3
  if (response.length > 500) {
    response = response.slice(0, 480) + '...\n\nA team member will follow up with full details.';
  }

  return { safe: true, response };
}

const SAFE_FALLBACK =
  "Thanks for the question. Let me have a team member follow up with the right details shortly.";
```

### Incident logging

Every guardrail trigger writes to a new `ai_incidents` table. Reviewed weekly by whoever owns AI quality.

---

## 7. Cost Controls & Circuit Breakers

### Per-session limits

```typescript
const SESSION_LIMITS = {
  maxAiResponses: 20,           // hard cap on AI replies per session
  maxInputTokens: 50_000,       // cumulative input tokens
  maxOutputTokens: 5_000,       // cumulative output tokens
  maxCostUsd: 0.50,             // hard ceiling per session
};
```

When hit:
- AI is disabled for the session (`sessions.metadata.aiDisabled = true`)
- Client gets "A team member will be with you shortly" + WhatsApp escalation fires
- Incident logged

### Per-day, per-CSM, per-org caps

Stored in `ai_budgets` table (see §8). Hourly rollup job updates spending. Crossing 80% triggers a warning email; 100% disables AI for that scope until next period.

### Provider circuit breaker

If Gemini error rate exceeds 5% over a 1-minute window:
- Open circuit for 60 seconds
- During open: route all `general_info` to canned fallback ("Team member will follow up")
- Log to Sentry + ops alert
- After 60s, half-open: try one request; if success, close; if fail, open another 60s

Use a library like `opossum` or implement a small one — don't roll auth/rate-limit logic, but circuit breaker is fine to write.

### Why a circuit breaker matters

Gemini outages happen. Without a circuit breaker, every client message during an outage:
1. Waits for Gemini timeout (30s default)
2. Returns 500 to user
3. Generates a Sentry alert
4. Burns the per-session token budget on retries

With a circuit breaker, you fail fast (50ms) to a canned fallback and the user gets a graceful response.

---

## 8. Schema Additions

These are **additive only** — no Phase 1 migrations are touched.

### Add to existing tables

```sql
-- Phase 2 migration 0002_ai.sql

-- Extend sender enum
ALTER TYPE message_sender_type ADD VALUE 'ai';

-- No other ALTERs needed; metadata jsonb columns absorb everything else.
```

### New tables

```typescript
// packages/db/src/schema-phase2.ts (added to schema.ts at Phase 2 start)

export const promptTemplates = pgTable('prompt_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 100 }).notNull(),  // 'system_general_info_v1'
  version: integer('version').notNull(),
  template: text('template').notNull(),
  variables: jsonb('variables').notNull().default([]),  // ['CLIENT_NAME', 'RAG_CONTEXT']
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdByUserId: uuid('created_by_user_id').references(() => users.id),
}, (t) => ({
  nameVersionUniqueIdx: uniqueIndex('prompt_templates_name_version_idx').on(t.name, t.version),
}));

export const aiIncidents = pgTable('ai_incidents', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'cascade' }),
  messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
  incidentType: varchar('incident_type', { length: 50 }).notNull(),
  // 'regex_block' | 'judge_block' | 'circuit_breaker' | 'budget_exceeded' | 'classifier_low_confidence'
  pattern: text('pattern'),
  rawResponse: text('raw_response'),
  metadata: jsonb('metadata').notNull().default({}),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  reviewedByUserId: uuid('reviewed_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  sessionIdx: index('ai_incidents_session_idx').on(t.sessionId),
  typeIdx: index('ai_incidents_type_idx').on(t.incidentType),
  reviewedIdx: index('ai_incidents_reviewed_idx').on(t.reviewedAt),
}));

export const aiBudgets = pgTable('ai_budgets', {
  id: uuid('id').primaryKey().defaultRandom(),
  scope: varchar('scope', { length: 30 }).notNull(),  // 'global' | 'csm' | 'session'
  scopeId: uuid('scope_id'),
  periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
  periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  responseCount: integer('response_count').notNull().default(0),
  estimatedCostUsd: numeric('estimated_cost_usd', { precision: 10, scale: 4 }).notNull().default('0'),
  limitInputTokens: integer('limit_input_tokens'),
  limitOutputTokens: integer('limit_output_tokens'),
  limitCostUsd: numeric('limit_cost_usd', { precision: 10, scale: 4 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  scopePeriodIdx: index('ai_budgets_scope_period_idx').on(t.scope, t.scopeId, t.periodStart),
}));

// pgvector for RAG (course catalog + FAQ embeddings)
export const knowledgeChunks = pgTable('knowledge_chunks', {
  id: uuid('id').primaryKey().defaultRandom(),
  source: varchar('source', { length: 50 }).notNull(),  // 'course' | 'faq' | 'policy'
  sourceId: varchar('source_id', { length: 100 }),
  title: varchar('title', { length: 255 }),
  content: text('content').notNull(),
  embedding: vector('embedding', { dimensions: 768 }),  // gemini text-embedding-004 is 768-dim
  metadata: jsonb('metadata').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  sourceIdx: index('knowledge_chunks_source_idx').on(t.source, t.sourceId),
  // pgvector HNSW index added via raw SQL in migration:
  // CREATE INDEX knowledge_chunks_embedding_idx ON knowledge_chunks
  //   USING hnsw (embedding vector_cosine_ops);
}));
```

### messages.metadata schema (Phase 2 usage)

```typescript
// What goes in messages.metadata when senderType = 'ai':
{
  provider: 'gemini',
  model: 'gemini-2.5-flash',
  promptTemplateId: '<uuid>',
  promptVersion: 3,
  intent: 'general_info',
  classifierSource: 'rules' | 'llm',
  classifierConfidence: 0.92,
  retrievedChunkIds: ['<uuid>', '<uuid>', '<uuid>'],
  inputTokens: 1247,
  outputTokens: 89,
  latencyMs: 1843,
  guardrailTriggered: false,
  streamingComplete: true,
}
```

---

## 9. Service Layer Design

```
apps/api/src/services/ai/
├── index.ts                    // Public API: aiService.respondTo(sessionId, message)
├── orchestrator.ts             // Main pipeline: redact → classify → route → generate → guard → persist
├── providers/
│   ├── llm-provider.ts         // Interface
│   ├── gemini-provider.ts      // Gemini implementation
│   ├── claude-provider.ts      // Stub for future
│   └── mock-provider.ts        // For tests
├── intent/
│   ├── rules.ts                // Regex-based first pass
│   ├── llm-classifier.ts       // Provider-backed second pass
│   └── canned-responses.ts     // Templates for non-AI intents
├── retrieval/
│   ├── embeddings.ts           // Embedding generation (provider-agnostic)
│   └── pgvector-search.ts      // Top-K retrieval from knowledge_chunks
├── prompts/
│   ├── loader.ts               // Load active prompt by name from DB
│   └── renderer.ts             // Variable substitution
├── guardrail/
│   ├── regex-check.ts
│   ├── llm-judge.ts
│   └── index.ts                // Orchestrate all checks
├── budget/
│   ├── tracker.ts              // Increment usage atomically
│   └── enforcer.ts             // Check limits before each call
├── circuit-breaker.ts
├── pii-redactor.ts             // Strip emails/phones before LLM
└── incidents.ts                // Log to ai_incidents
```

### Public entry point

```typescript
// services/ai/index.ts

export const aiService = {
  /**
   * Generate an AI response to a client message in a session.
   * Returns null if AI is disabled, budget exceeded, or intent
   * routes to canned/escalation (those are handled by caller).
   */
  async respondTo(
    sessionId: string,
    clientMessage: Message
  ): Promise<AiResponseResult> {
    return orchestrator.run(sessionId, clientMessage);
  },
};
```

### When the AI service is invoked

A new `ai-fallback-job` runs in BullMQ. The job is enqueued whenever a client sends a message. The job evaluates the precise trigger condition below.

**Exact trigger condition (all must be true):**

```
1. Session status is in ('active', 'csm_handling')
2. AI is not disabled for the session (sessions.metadata.aiDisabled !== true)
3. AI provider circuit breaker is closed
4. The latest CSM message in the session is older than the inactivity threshold:
   - 90 seconds if no CSM message has ever been sent in this session
   - 300 seconds (5 min) for subsequent CSM gaps
5. The CSM is not currently online (no active WebSocket connection)
   OR the CSM has been online for >30s without sending a message
6. Per-session AI budget is not exceeded
   (responseCount < 20 AND inputTokens < 50K AND costUsd < $0.50)
7. Per-org/global AI budget is not exceeded
8. The most recent message in the session is from the client
   (don't reply to AI messages or CSM messages)
9. No AI response has been generated in the last 30 seconds
   (debounce — clients sometimes send 3 messages in a row)
```

If ALL conditions are met → enqueue `ai-fallback-job` with 90s delay (or 300s for subsequent triggers). When the job runs, it re-checks all conditions (the CSM may have responded in the meantime). If any condition is now false → no-op exit, no incident.

**Working hours awareness:** at off-hours (configurable per CSM), the inactivity threshold is reduced to 30 seconds and the canned/AI response uses off-hours phrasing ("our team will respond tomorrow morning IST" instead of "shortly").

If response generated → broadcast via WebSocket as `senderType='ai'` message.

---

## 10. WebSocket & UX Integration

### New message events

```typescript
// Server → session:<id> room
'message:ai_streaming' { messageId, chunk, done }  // for streaming UX
'message:new'          Message  // final, persisted (senderType='ai')
'session:ai_status'    { aiEnabled: boolean, reason?: string }
```

### Client UX rules

When `message.senderType === 'ai'`:
- Render with a distinct visual treatment: subtle bot icon, slightly muted color
- Add inline badge: "Auto-response — a team member will follow up"
- Stream tokens as they arrive (typing-like effect)
- Allow client to "thumbs down" the response → writes to `ai_incidents`

### CSM dashboard additions

When CSM opens a session that had AI activity:
- Banner at top: "AI responded {N} times in this conversation"
- Timeline view: each AI response collapsible, showing intent + retrieved chunks
- One-click "Retract AI response" — sends a `system` message: "An earlier auto-response may have been incorrect. The accurate answer is below." then CSM replies.

---

## 11. Prompt Versioning & Eval Framework

### Prompt management

All system prompts live in `prompt_templates` table. Code references them by name + version:

```typescript
const template = await promptLoader.getActive('system_general_info');
const rendered = render(template, { CLIENT_NAME, RAG_CONTEXT, ... });
```

Changing a prompt = inserting a new row with `version = old + 1`, setting `is_active = true` on new and `false` on old. Never edit in place. Always reversible.

### Eval framework

Located in `apps/api/eval/`. Two types of evals:

**1. Regression suite** — 50 hand-curated test conversations covering:
- Pricing queries that should be canned (15 cases)
- Availability queries that should be canned (10 cases)
- General info queries with correct answers (15 cases)
- Edge cases: code-switching English/Hindi, typos, multi-question messages, complaints disguised as questions (10 cases)

Each test case has:
```yaml
- id: pricing_001
  input: "What is the price for the Java certification course?"
  expected_intent: pricing_query
  expected_response_type: canned
  must_not_contain: ["₹", "$", "rupees", "free", "discount"]
  must_contain_one_of: ["check", "team", "follow up"]
```

**2. Judge-graded evals** — for `general_info` responses, use a stronger model (or human review) to grade on:
- Accuracy (was the info right per RAG context?)
- Tone (warm, professional)
- Brevity (under 100 words)
- No-commitment (no implicit promises)

### When evals run

- On every change to prompts, intent rules, guardrail rules, or provider config
- Block deploy if regression suite fails any P0 test
- Weekly automated run on production samples (sampled 1% of real conversations, with PII redacted)

---

## 12. Failure Modes & Fallbacks

| Failure | Detection | Fallback |
|---------|-----------|----------|
| Gemini API outage | Circuit breaker opens | Canned "team member will follow up" |
| Classifier returns low confidence | Confidence < 0.7 | Treat as `out_of_scope`, polite redirect |
| Guardrail blocks response | Regex or judge match | Canned safe fallback + incident log |
| RAG returns no relevant chunks | Top similarity < 0.5 | Skip generation, escalate to human |
| Budget exceeded | Pre-call check | Disable AI for session, escalate |
| PII redactor fails (regex error) | Try/catch | Skip AI for that message, escalate |
| Embedding service down | Try/catch | Skip generation (RAG is required) |
| Streaming disconnects mid-response | Socket error | Persist partial, mark incomplete |
| Prompt template missing | DB lookup fails | Hard fail to canned fallback, P0 alert |

**Key principle:** every failure mode falls back to a canned response, never to silence and never to an unbounded retry.

---

## 13. Phase 2.0 (Lean Release) vs Phase 2.1 (Full)

The full architecture above is the target. If you want to ship Phase 2.0 faster, defer the items below to Phase 2.1. The deferred items can all be added without schema changes or refactors — the architecture accommodates them.

### What Phase 2.0 (lean release) MUST include — non-negotiable

These are load-bearing for safety and cost. Do not defer:

- **Provider abstraction** — costs ~50 lines of code, prevents lock-in
- **PII redaction** with obfuscation patterns
- **Intent classification** (rules-only is acceptable; defer LLM classifier to 2.1)
- **Canned responses** for `pricing_query`, `trainer_availability`, `urgent_complaint`, `greeting`, `out_of_scope`
- **Output regex guardrail** (the deterministic check)
- **RAG via pgvector** — without grounding, the model invents course names. This is the failure mode the entire safety architecture exists to prevent. Do NOT defer this.
- **Per-session cost cap** (the simple version: count responses + tokens, hard stop at 20/50K)
- **Provider circuit breaker**
- **Per-request timeout + retry policy**
- **Working hours awareness** for trigger threshold

### What Phase 2.0 can defer to Phase 2.1

These are quality-of-life and observability features. Build only after you've shipped 2.0 and have real usage data:

- **LLM-as-judge guardrail** (start with regex only; add judge if regex misses real cases)
- **Streaming responses** (start with non-streaming; UX is acceptable, simpler to debug)
- **LLM-based intent classifier** (pass 2; rules cover ~85% of intents anyway)
- **Per-org / per-CSM budget rollups** (start with per-session caps only)
- **Eval framework with regression suite** (defer until you have 100+ real conversations to learn what to test)
- **Prompt versioning system** (Phase 2.0 can hardcode prompts in code; switch to DB-backed when you start iterating)
- **Thumbs-down feedback UI** (collect via simple emoji button, store in `ai_incidents`)
- **CSM retraction flow** (Phase 2.0: CSM types correction message manually)

### Implementation rule for the deferral

If you defer something from Phase 2.0, mark its location in the code with:

```typescript
// PHASE_2_1: replace with [feature name] when shipping 2.1
```

Don't comment-out scaffolding. Just leave the seam clean.

---

## 14. Implementation Order

When Phase 1 is shipped and stable, execute this order. Same "stop after each step" discipline as Phase 1.

### Step P2-1 — Foundations
- Add Phase 2 schema migrations (sender enum extension, new tables, pgvector extension)
- Seed initial prompt templates
- Create `packages/shared/src/ai/` with provider interface

### Step P2-2 — Provider implementation
- `GeminiProvider` with full interface implementation
- `MockProvider` for tests
- Unit tests for both
- **Stop. Confirm: can call Gemini and get a response in test.**

### Step P2-3 — Intent classification
- Rules module with all patterns
- LLM classifier using provider
- Canned response renderer
- Tests covering all routing decisions
- **Stop. Confirm: classifier hits expected category for 50 sample messages.**

### Step P2-4 — RAG ingestion
- Embedding generation pipeline (CSV → embeddings → `knowledge_chunks`)
- Top-K retrieval service
- Initial knowledge base ingest (course catalog + FAQ from product team)
- **Stop. Confirm: retrieval returns sensible chunks for sample queries.**

### Step P2-5 — Generation + guardrails
- Prompt loader and renderer
- Generation orchestrator
- Regex guardrail
- LLM-judge guardrail
- Incident logging
- Tests covering all paths including bypass attempts
- **Stop. Confirm: regression suite passes.**

### Step P2-6 — Budget + circuit breaker
- Budget tracker (atomic increment)
- Enforcer (pre-call check)
- Circuit breaker around provider calls
- Hourly budget rollup job
- **Stop. Confirm: simulated budget exhaustion routes to fallback.**

### Step P2-7 — BullMQ job + WebSocket integration
- AI fallback job triggered by message events
- Streaming via Socket.IO
- New `message:ai_streaming` and `session:ai_status` events
- Persist after stream completes
- **Stop. Confirm: end-to-end client message → AI response visible in real time.**

### Step P2-8 — Frontend integration
- AI message visual treatment + badge
- Streaming display
- Thumbs-down feedback
- CSM dashboard AI banner + retraction flow

### Step P2-9 — Eval and rollout
- Run full regression suite
- Enable AI for 1 CSM (feature flag)
- Monitor incidents daily for 1 week
- Expand to all CSMs

---

## 15. Open Questions Before Phase 2 Starts

Answer these before opening `PHASE2_AI_DESIGN.md` for build:

1. **What's the actual content of the knowledge base?** Course catalog where? FAQ where? Who maintains it?
2. **Who owns AI quality reviews?** Weekly incident review needs a person.
3. **What's the budget?** Need monthly USD ceiling to set per-org limits.
4. **Streaming or non-streaming?** Streaming is better UX but ~30% more complexity. Default recommendation: streaming.
5. **Should AI introduce itself?** First AI response in a session — does it explicitly say "I'm an automated assistant"? Default recommendation: yes.
6. **Threshold for AI fallback trigger:** 90 seconds? 2 minutes? 5 minutes? Default recommendation: 90 seconds for first message, 5 minutes for subsequent.
7. **Working hours awareness:** Should AI behave differently at 2am IST? Default recommendation: yes — at off-hours, AI says "team will respond tomorrow" instead of "shortly."
8. **Hindi / regional language support:** Phase 2 English-only or include?
9. **What counts as "complaint"?** Tone analysis or keyword-based? Default: keyword first, expand later.
10. **Retention of AI incident logs:** 6 months? 1 year? Indefinite?

---

## END OF PHASE 2 DESIGN

This document is locked at v1.0 on 2026-04-27. Modifications require explicit version bump and changelog entry below.

### Changelog
- **v1.0 (2026-04-27)**: Initial locked design.
