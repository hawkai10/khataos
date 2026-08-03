# AI Assistant — KhataOS Copilot

The Copilot answers cash-flow, payables, payments, reconciliation, GST and
Tally questions from **live platform data**, Monday.com-style: a slide-over
panel in the web app, data-derived suggestions, and one-click navigation to
the right screen.

It runs in two modes:

| Mode | When | Behavior |
| --- | --- | --- |
| **Rule engine** (default) | No `DEEPSEEK_API_KEY` | Deterministic, tenant-scoped answers computed from the DB. Zero cost, fully offline, used by the test suite. |
| **Generative** | `DEEPSEEK_API_KEY` set | The same live data is compacted into a token-efficient JSON snapshot and sent to **DeepSeek V4 Flash** (`deepseek-v4-flash`, OpenAI-compatible chat completions). Answers are rephrased/expanded by the LLM and suggestions are prioritized by it. Any API error or malformed output falls back to the rule engine, so the assistant never fails open with hallucinated numbers. |

## Setup

```powershell
Copy-Item .env.example .env   # first time only
notepad .env                  # set DEEPSEEK_API_KEY
node server/src/server.js
```

The server auto-loads `.env` at startup (shell environment variables win).
Relevant variables:

| Env var | Default | Meaning |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | — | DeepSeek API key; presence enables the LLM |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | OpenAI-compatible endpoint |
| `DEEPSEEK_MODEL` | `deepseek-v4-flash` | Model name (V4 Flash non-thinking mode) |
| `DEEPSEEK_TIMEOUT_MS` | `15000` | Per-call timeout; on timeout the rule engine answers |
| `AI_DISABLED` | — | Set to `1` to force the rule engine even with a key |

Check status at `GET /api/assistant/prompts` (`data.status`) or under
`integrations.ai` in System Health. The Copilot panel footer also shows the
active engine.

## How it stays grounded (guardrails)

The design follows the patterns of two widely adopted open-source projects:

- **NVIDIA NeMo Guardrails** (~7k stars / ~750 forks) — the canonical
  programmable-guardrails toolkit. Its *input / dialog / retrieval /
  execution / output* rail model is applied here as deterministic code:
  - **Input rail** — the question is always paired with a scope instruction;
    off-topic questions are refused and redirected.
  - **Output rail** — the model must return a strict JSON object; parsing is
    enforced in code, not promised in the prompt.
  - **Execution rail** — the model can only *suggest* UI navigation, never
    claim it performed an action.
- **AI4Finance FinGPT / FinRobot** (~7k / ~1.9k stars) — open-source financial
  LLM and agent platforms. Borrowed patterns: answers are grounded in a
  structured financial data snapshot, and "not enough data" is an explicit,
  honest answer.

Concrete rails implemented in `server/src/ai.js`:

1. **Grounded-in-data** — the system prompt forbids inventing numbers and the
   snapshot is the only data the model sees. Missing data → the model must say
   what's missing and how to get it.
2. **No-action claims** — actions are limited to a hard-coded view allowlist
   (`dashboard, cash, payables, payments, recon, gst, tally, system, settings`);
   anything else is dropped by `parseLlm`, in code.
3. **Scope refusal** — off-topic, personal, general-knowledge, investment-tip
   and authoritative tax/legal questions get a polite one-sentence refusal with
   `intent: "off_topic"` and no actions.
4. **JSON output rail** — `response_format: json_object`, temperature 0.2, and a
   strict parser that accepts plain or fenced JSON and rejects anything else.
5. **Graceful degradation** — any LLM error (timeout, HTTP error, bad JSON)
   falls back to the deterministic rule engine. The assistant never answers
   from thin air.

## Token efficiency

- Context is a **compact JSON snapshot** (`compactContext`): short keys
  (`cash`, `due`, `gst`, `recon`, …), capped arrays (6 due, 6 overdue, 5
  mismatches, 4 spend buckets, 3 failed payments, 5 top vendors), raw numbers
  instead of formatted strings, and freshness expressed as minutes.
- `max_tokens`: 450 for answers, 260 for suggestions.
- **Stateless** — no conversation history is sent, so each question costs one
  compact round-trip (suggestions panel = one call when opened).
- System prompt is ~330 tokens and carries every rail inline.

## Cost note

V4 Flash is DeepSeek's low-cost tier; typical usage (a few dozen questions per
day) costs well under ₹1/day at current pricing. For multi-tenant production,
consider per-tenant usage metering — the `intent_status()` payload already
reports the active model/provider for observability.
