# ADR-0006: AI is optional; company-chosen provider through an admin-configured gateway

- Status: Accepted
- Date: 2026-10-15

## Context

Companies differ: some forbid sending data to US vendors, some already pay for OpenAI/Anthropic/Gemini, some run Ollama on their own hardware, many have no AI budget at all. The product must be fully useful without AI, must not lock in a vendor, and must let a non-technical admin connect AI without editing server files. Vendor outages and rate limits must not break features.

## Decision

- **Optional**: without any provider, ai-service reports `configured: false`; generative routes answer `503 ai_not_configured` (`backend/services/ai/src/status.ts`) and the web hides AI UI. Monitoring and oversight ([ADR-0007](0007-ai-oversight-extension-transparency.md)) never depend on it.
- **One model gateway** (`backend/services/ai/src/gateway.ts`): callers name a feature and a tier (`fast`/`smart`), never a vendor. Routes `provider:model`; per-feature overrides; retriable failures (timeout, 408/409/429, 5xx, network) fall through `AI_FALLBACK`, default ending in the deterministic `local:local-extractive` provider; a circuit breaker skips a route for 60 s after 429 and 30 s after other failures.
- **Admin-configured connections** (Admin › AI, `connections.ts`, `connections.controller.ts`, table `ai_connections`): three modes — `key` (OpenAI, Anthropic, Gemini API key), `api` (any OpenAI-compatible endpoint: OpenRouter, LiteLLM, Azure OpenAI, vLLM), `selfhost` (Ollama, LM Studio, llama.cpp; usually no key). One default connection per workspace drives every feature; others appear in the assistant's model menu. Test and check endpoints validate before saving. (2026-11-11) The default is everyone's default, not everyone's only choice: a person may answer their own questions with the AI on their own connected computer (`ai_personal_choice`), which the company can turn off; the company's AI answers whenever that computer is off.
- Keys are **encrypted with AES-256-GCM** before reaching the database; key = SHA-256(`AI_SECRETS_KEY`) if set, else HKDF(`INTERNAL_TOKEN_SECRET`, "ai-connections/v1"); in production the dev default secret is refused. Admins only ever see `…last4`.
- Env vendors (`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `AI_*`) remain for operators; `TenantGateway` merges env and connections per tenant (30 s cache).
- Every call is metered (`ai_usage`) and bounded by the monthly budgets admins set (`ai_budgets`; the plan-based `tenant_quota` was removed, see [ADR-0011](0011-ai-usage-linked-to-work.md)); tools run as the asking person with `authorize()` and content is wrapped as untrusted.

## Consequences

- No vendor lock-in; data residency is the company's choice (self-hosted model keeps prompts on-premise).
- Feature quality varies with the model; the local extractive provider is a floor, not parity.
- **Rotating `INTERNAL_TOKEN_SECRET` without `AI_SECRETS_KEY`, or changing `AI_SECRETS_KEY`, makes stored keys unreadable**; admins must re-enter them (connection test shows the error). There is no re-encryption tool. Operators should set `AI_SECRETS_KEY` at install time.
- Circuit-breaker and cache state is per ai-service instance.
