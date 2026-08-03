'use strict';

// ============================================================================
// KhataOS Copilot — data-grounded finance assistant.
//
// Default: deterministic rule engine over the platform DB (works offline,
// used by the E2E suite).
//
// Generative: when DEEPSEEK_API_KEY is set (see .env.example), the same live
// data is compacted into a token-efficient JSON snapshot and sent to DeepSeek
// V4 Flash (OpenAI-compatible chat completions). Design follows the patterns
// of NVIDIA NeMo Guardrails (~7k stars; input/dialog/output rails enforced in
// code, not just prompts) and AI4Finance's FinGPT/FinRobot (grounded finance
// agents): every answer is grounded in the provided snapshot, actions are
// restricted to an allowlist of UI views, and refusals are deterministic.
// ============================================================================

const { all, get } = require('./db');
const { todayStr, daysAgo, daysAhead, inr, formatINR, minsSince } = require('./util');
const recon = require('./recon');
const { TallyConnector } = require('./adapters');

// ---- provider config ----
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || process.env.AI_API_KEY || '';
const DEEPSEEK_URL = (process.env.DEEPSEEK_BASE_URL || process.env.AI_PROVIDER_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || process.env.AI_MODEL || 'deepseek-v4-flash';
const DEEPSEEK_TIMEOUT_MS = Number(process.env.DEEPSEEK_TIMEOUT_MS || 15000);
const AI_ENABLED = !!DEEPSEEK_KEY && process.env.AI_DISABLED !== '1';

const fmt = formatINR;
const VIEWS = new Set(['dashboard', 'cash', 'payables', 'payments', 'recon', 'gst', 'tally', 'system', 'settings']);
const INTENTS = ['cash', 'payments', 'gst', 'recon', 'tally', 'runway', 'suggestions', 'general', 'off_topic'];

// ----------------------------------------------------------------------------
// Guardrailed system prompt (token-efficient: ~330 tokens, all rails inline)
// ----------------------------------------------------------------------------
const SYS_PROMPT = [
  'You are KhataOS Copilot, the AI assistant inside KhataOS — an Indian finance operating platform for mid-market companies (₹50–500 Cr revenue). You answer finance-operations questions using ONLY the DATA JSON in the user message.',
  'RULES:',
  '1 GROUNDING: Never invent numbers, invoices, vendors or dates. If the data lacks an answer, say what is missing and how to get it (connect a bank, refresh GSTR-2B, sync Tally).',
  '2 NO ACTIONS: You never execute or change anything. You may only suggest UI actions through the "actions" array, using allowed views: dashboard, cash, payables, payments, recon, gst, tally, system, settings.',
  '3 SCOPE: Only finance operations topics — cash, payables, payments, reconciliation, GST/ITC, runway/burn, Tally, vendors, spend. For anything else (personal, general knowledge, code, investment tips, authoritative tax/legal advice) reply in one polite sentence that you only cover the company\'s finance operations, set intent to "off_topic", and suggest a finance question.',
  '4 COMPLIANCE: Never present tax or legal statements as authoritative — recommend confirming with the company CA/auditor when relevant.',
  '5 FORMAT: Answer in ≤ 90 words. Indian conventions: ₹ with lakh/crore grouping (e.g. ₹1.25 Cr), dates dd MMM yyyy. Short bullet lists are fine.',
  'OUTPUT: Reply with ONLY one JSON object: {"intent":"cash|payments|gst|recon|tally|runway|suggestions|general|off_topic","answer":"...","actions":[{"label":"...","view":"..."}]}',
].join('\n');

const SUGGEST_PROMPT = [
  'You are KhataOS Copilot. From the DATA JSON, list up to 4 prioritized, specific actions for the Indian finance team.',
  'RULES: only actions that clearly follow from the data; each action needs an allowed view (dashboard, cash, payables, payments, recon, gst, tally, system, settings); never invent numbers.',
  'OUTPUT: Reply with ONLY one JSON object: {"intent":"suggestions","answer":"one-line summary","actions":[{"label":"...","view":"..."}]}',
].join('\n');

// ----------------------------------------------------------------------------
// Data accessors (tenant-scoped)
// ----------------------------------------------------------------------------
async function cashPosition(coId) {
  const accounts = await all('SELECT * FROM bank_accounts WHERE company_id = ?', [coId]);
  let available = 0;
  for (const a of accounts) {
    const last = await get('SELECT closing_balance FROM cash_daily WHERE account_id = ? ORDER BY date DESC LIMIT 1', [a.id]);
    available += last ? last.closing_balance : 0;
  }
  const uncleared = inr((await all(`SELECT COALESCE(SUM(amount),0) AS u FROM bank_transactions WHERE company_id = ? AND status='uncleared' AND amount > 0`, [coId]))[0].u);
  const last_synced_at = (await get('SELECT MAX(last_synced_at) AS t FROM bank_accounts WHERE company_id = ?', [coId])).t;
  return { available: inr(available), uncleared, accounts: accounts.length, last_synced_at };
}

async function duePayments(coId) {
  const rows = await all(`SELECT i.*, v.name AS vendor_name FROM invoices i LEFT JOIN vendors v ON v.id = i.vendor_id
    WHERE i.company_id = ? AND i.status IN ('approved','scheduled','pending_approval') AND i.due_date >= ? AND i.due_date <= ?
    ORDER BY i.due_date`, [coId, todayStr(), daysAhead(7)]);
  const overdue = await all(`SELECT i.*, v.name AS vendor_name FROM invoices i LEFT JOIN vendors v ON v.id = i.vendor_id
    WHERE i.company_id = ? AND i.status IN ('approved','scheduled') AND i.due_date < ? ORDER BY i.due_date`, [coId, todayStr()]);
  return {
    rows, overdue,
    due_amount: inr(rows.reduce((s, i) => s + i.net_payable, 0)),
    overdue_amount: inr(overdue.reduce((s, i) => s + i.net_payable, 0)),
  };
}

async function runwayCalc(coId) {
  const cash = await cashPosition(coId);
  const outflows = await all(`SELECT COALESCE(SUM(amount),0) AS s FROM bank_transactions WHERE company_id = ? AND amount < 0 AND txn_date >= ?`, [coId, daysAgo(89)]);
  const burn = inr(Math.abs(outflows[0].s) / 3);
  return { available: cash.available, monthly_burn: burn, runway_months: burn > 0 ? inr(cash.available / burn) : null };
}

async function gstPosition(coId) {
  const snap = await get('SELECT * FROM gstr2b_snapshots WHERE company_id = ? ORDER BY period DESC LIMIT 1', [coId]);
  const liability = inr((await all(`SELECT COALESCE(SUM(net_payable),0) AS s FROM invoices WHERE company_id = ? AND status IN ('approved','scheduled')`, [coId]))[0].s);
  const mismatches = await all(`SELECT * FROM gst_mismatches WHERE company_id = ? AND status = 'open' ORDER BY period DESC`, [coId]);
  return { itc: snap ? snap.total_itc : 0, period: snap ? snap.period : null, liability, mismatches };
}

async function reconPosition(coId) {
  const s = await recon.score(coId);
  const unmatched = await all(`SELECT * FROM bank_transactions WHERE company_id = ? AND matched = 0 AND status = 'posted' AND txn_date >= ? ORDER BY txn_date DESC LIMIT 5`, [coId, daysAgo(30)]);
  return { ...s, unmatched };
}

async function spendBreakdown(coId) {
  const txns = await all(`SELECT amount, mode, description FROM bank_transactions WHERE company_id = ? AND amount < 0 AND txn_date >= ?`, [coId, daysAgo(29)]);
  const buckets = { 'Vendor payments': 0, 'Statutory (GST/TDS)': 0, 'Salaries': 0, 'Operating expenses': 0, 'Bank charges': 0, 'Other': 0 };
  for (const t of txns) {
    const d = String(t.description || '').toUpperCase();
    const a = Math.abs(t.amount);
    if (d.includes('GST-DEPOSIT') || d.includes('TDS-') || d.includes('GST DEPOSIT')) buckets['Statutory (GST/TDS)'] += a;
    else if (d.includes('SALARY')) buckets['Salaries'] += a;
    else if (d.includes('BANK CHARGES') || d.includes('NEFT CHARGES') || d.includes('CHARGES')) buckets['Bank charges'] += a;
    else if (d.includes('OUTWARD') || d.includes('PAYMENT') || ['NEFT', 'IMPS', 'RTGS'].includes(t.mode)) buckets['Vendor payments'] += a;
    else if (d.includes('RENT') || d.includes('ELECTRICITY') || d.includes('FUEL') || d.includes('COURIER') || d.includes('SUPPLIES') || d.includes('INTERNET')) buckets['Operating expenses'] += a;
    else buckets['Other'] += a;
  }
  const total = Object.values(buckets).reduce((s, v) => s + v, 0);
  const rows = Object.entries(buckets).map(([category, amount]) => ({ category, amount: inr(amount), share: total ? inr((amount / total) * 100) : 0 })).sort((a, b) => b.amount - a.amount);
  return { rows, total: inr(total) };
}

async function pendingApprovals(coId, role) {
  return all(`SELECT a.*, i.invoice_no, i.gross_amount, v.name AS vendor_name FROM approvals a
    JOIN invoices i ON i.id = a.invoice_id LEFT JOIN vendors v ON v.id = i.vendor_id
    WHERE a.company_id = ? AND a.status = 'pending' AND a.required_role = ? ORDER BY i.due_date LIMIT 8`, [coId, role]);
}

// ---- token-efficient context snapshot (short keys, capped arrays, raw numbers) ----
async function compactContext(coId, role) {
  const due = await duePayments(coId);
  const cash = await cashPosition(coId);
  const rw = await runwayCalc(coId);
  const g = await gstPosition(coId);
  const r = await reconPosition(coId);
  const tally = await TallyConnector.health(coId);
  const spend = await spendBreakdown(coId);
  const failed = await all(`SELECT reference, amount FROM payments WHERE company_id = ? AND status = 'failed' ORDER BY created_at DESC LIMIT 3`, [coId]);
  const pending = await pendingApprovals(coId, role);
  const topVendors = await all(`SELECT v.name, SUM(i.net_payable) amt FROM vendors v JOIN invoices i ON i.vendor_id = v.id
    WHERE v.company_id = ? AND i.status IN ('approved','scheduled','pending_approval') GROUP BY v.id ORDER BY amt DESC LIMIT 5`, [coId]);
  return {
    cash: { available: cash.available, uncleared: cash.uncleared, accounts: cash.accounts, synced_min: minsSince(cash.last_synced_at) },
    runway: { months: rw.runway_months, burn: rw.monthly_burn },
    due: due.rows.slice(0, 6).map((i) => ({ no: i.invoice_no, vendor: i.vendor_name, net: i.net_payable, due: i.due_date })),
    overdue: due.overdue.slice(0, 6).map((i) => ({ no: i.invoice_no, vendor: i.vendor_name, net: i.net_payable, due: i.due_date })),
    approvals_pending: pending.slice(0, 6).map((a) => ({ no: a.invoice_no, amt: a.gross_amount, role: a.required_role })),
    gst: { itc: g.itc, liability: g.liability, period: g.period, open_mismatches: g.mismatches.length, mismatches: g.mismatches.slice(0, 5).map((m) => ({ inv: m.invoice_no, variance: m.variance })) },
    recon: { accuracy: r.accuracy, matched: r.auto_matched, total: r.total, target: r.target, unmatched_30d: r.unmatched.length },
    tally: { status: tally.status, synced_min: minsSince(tally.last_sync_at), uptime_30d: tally.uptime_30d },
    spend_30d: spend.rows.slice(0, 4).map((x) => ({ cat: x.category, amt: x.amount })),
    failed_payments: failed.map((p) => ({ ref: p.reference, amt: p.amount })),
    top_vendors: topVendors.map((v) => ({ name: v.name, amt: v.amt })),
  };
}

// ----------------------------------------------------------------------------
// DeepSeek V4 Flash client (OpenAI-compatible)
// ----------------------------------------------------------------------------
async function callLlm(messages, maxTokens) {
  if (!AI_ENABLED) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DEEPSEEK_TIMEOUT_MS);
  try {
    const resp = await fetch(`${DEEPSEEK_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${DEEPSEEK_KEY}` },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages,
        temperature: 0.2,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) return null;
    const json = await resp.json().catch(() => null);
    const text = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    return text ? String(text).trim() : null;
  } catch {
    return null; // API errors degrade gracefully to the rule engine
  } finally {
    clearTimeout(timer);
  }
}

// ---- output rail: strict JSON parse + view allowlist (deterministic) ----
function parseLlm(text) {
  if (!text) return null;
  let cleaned = String(text);
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) cleaned = fence[1];
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) cleaned = cleaned.slice(start, end + 1);
  let obj;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    return null;
  }
  const answer = typeof obj.answer === 'string' && obj.answer.trim() ? obj.answer.trim().slice(0, 800) : null;
  if (!answer) return null;
  const intent = INTENTS.includes(obj.intent) ? obj.intent : 'general';
  const actions = Array.isArray(obj.actions)
    ? obj.actions
        .map((a) => ({ label: String((a && a.label) || '').slice(0, 80), view: String((a && a.view) || '') }))
        .filter((a) => a.label && VIEWS.has(a.view))
        .slice(0, 3)
    : [];
  return { intent, answer, actions };
}

// ----------------------------------------------------------------------------
// Rule engine (offline default + fallback)
// ----------------------------------------------------------------------------
const INTENT_PATTERNS = [
  { id: 'suggestions', re: /should i|suggest|recommend|what can|what now|action items|to-?do|priorit|focus|advice|help me/i },
  { id: 'runway', re: /runway|burn rate|how long.*cash|months.*(left|last)|survive|out of cash/i },
  { id: 'cash', re: /cash|balance|available|funds?|position|money.*bank|total.*account|bank account/i },
  { id: 'due', re: /due|upcoming|this week|next week|pay.*(this|next) week|what.*pay/i },
  { id: 'overdue', re: /overdue|late payment|missed/i },
  { id: 'gst', re: /gst|itc|input credit|liability|gstr|mismatch|compliance|tax/i },
  { id: 'recon', re: /recon|unmatched|match|reconcile|cleared/i },
  { id: 'tally', re: /tally|sync|connector|voucher|ledger/i },
  { id: 'approvals', re: /approve|approval|pending.*invoice|invoice.*pending|awaiting/i },
  { id: 'failed', re: /fail|declin|rejected payment|payment.*(fail|declin)/i },
  { id: 'vendors', re: /vendor|supplier|who.*owe|whom.*owe|top.*creditor/i },
  { id: 'spend', re: /spend|outflow|expense|where.*(money|cash)|going.*out|cash going/i },
  { id: 'greeting', re: /^(hi|hello|hey|namaste|good (morning|afternoon|evening))\b/i },
];

function detectIntent(q) {
  const t = String(q || '').toLowerCase();
  for (const i of INTENT_PATTERNS) if (i.re.test(t)) return i.id;
  return 'unknown';
}

async function answerFor(intent, coId, user) {
  switch (intent) {
    case 'cash': {
      const c = await cashPosition(coId);
      const mins = minsSince(c.last_synced_at);
      return {
        intent, data: c,
        answer: `You have ${fmt(c.available)} available across ${c.accounts} accounts${c.uncleared ? `, plus ${fmt(c.uncleared)} uncleared (cheques in clearing)` : ''}${mins != null ? ` — synced ${mins} min ago` : ''}.`,
      };
    }
    case 'runway': {
      const r = await runwayCalc(coId);
      return {
        intent, data: r,
        answer: r.runway_months != null
          ? `At the current burn of ${fmt(r.monthly_burn)}/month, available cash of ${fmt(r.available)} gives you roughly ${r.runway_months} months of runway.`
          : `We couldn't compute runway from recent outflows.`,
      };
    }
    case 'due': {
      const d = await duePayments(coId);
      const ov = d.overdue.length ? ` There are also ${d.overdue.length} overdue invoices worth ${fmt(d.overdue_amount)}.` : '';
      return {
        intent, data: d,
        answer: d.rows.length
          ? `${d.rows.length} payment${d.rows.length === 1 ? '' : 's'} worth ${fmt(d.due_amount)} are due this week.${ov}`
          : `Nothing is due this week${d.overdue.length ? `, but ${d.overdue.length} invoice${d.overdue.length === 1 ? '' : 's'} are overdue (${fmt(d.overdue_amount)})` : ''}.`,
      };
    }
    case 'overdue': {
      const d = await duePayments(coId);
      return {
        intent: 'due', data: { rows: d.overdue, overdue_amount: d.overdue_amount, due_amount: 0 },
        answer: d.overdue.length ? `${d.overdue.length} invoice${d.overdue.length === 1 ? '' : 's'} worth ${fmt(d.overdue_amount)} are overdue.` : 'Nothing is overdue.',
      };
    }
    case 'gst': {
      const g = await gstPosition(coId);
      return {
        intent, data: g,
        answer: `ITC available for ${g.period || 'the latest period'} is ${fmt(g.itc)} and pending GST liability on approved invoices is ${fmt(g.liability)}. There ${g.mismatches.length === 1 ? 'is 1 open GSTR-2B mismatch' : `are ${g.mismatches.length} open GSTR-2B mismatches`} to review.`,
      };
    }
    case 'recon': {
      const r = await reconPosition(coId);
      return {
        intent, data: r,
        answer: `Bank reconciliation is at ${r.accuracy}% automatic (${r.auto_matched} of ${r.total} transactions in the last 30 days)${r.unmatched.length ? `. ${r.unmatched.length} of the most recent unmatched entries are listed for review` : ''}.`,
      };
    }
    case 'tally': {
      const h = await TallyConnector.health(coId);
      const mins = minsSince(h.last_sync_at);
      return {
        intent, data: h,
        answer: `Tally connector is ${h.status === 'connected' ? 'healthy' : h.status} (${h.version || 'TallyPrime'}, ${h.mode || 'single-user'})${mins != null ? ` — last sync ${mins} min ago` : ''}, uptime ${h.uptime_30d != null ? h.uptime_30d + '%' : 'n/a'} over 30 days.`,
      };
    }
    case 'approvals': {
      const rows = await pendingApprovals(coId, user.role);
      return {
        intent, data: { rows, role: user.role },
        answer: rows.length ? `${rows.length} invoice${rows.length === 1 ? '' : 's'} are waiting for your (${user.role.replace('_', ' ')}) approval, worth ${fmt(rows.reduce((s, r) => s + r.gross_amount, 0))}.` : 'You have no invoices waiting on your approval right now.',
      };
    }
    case 'failed': {
      const rows = await all(`SELECT p.*, v.name AS vendor_name FROM payments p LEFT JOIN vendors v ON v.id = p.vendor_id WHERE p.company_id = ? AND p.status = 'failed' ORDER BY p.created_at DESC LIMIT 8`, [coId]);
      return {
        intent, data: { rows },
        answer: rows.length ? `${rows.length} failed payment${rows.length === 1 ? '' : 's'} found — ${rows.map((r) => r.reference).join(', ')}. Check the failure reason and retry.` : 'No failed payments right now.',
      };
    }
    case 'vendors': {
      const rows = await all(`SELECT v.id, v.name, SUM(i.net_payable) AS amount, COUNT(i.id) AS invoices FROM vendors v
        JOIN invoices i ON i.vendor_id = v.id
        WHERE v.company_id = ? AND i.status IN ('approved','scheduled','pending_approval')
        GROUP BY v.id ORDER BY amount DESC LIMIT 6`, [coId]);
      return {
        intent, data: { rows },
        answer: rows.length ? `Your top payables: ${rows.map((r) => `${r.name} (${fmt(r.amount)})`).join(', ')}.` : 'No outstanding payables.',
      };
    }
    case 'spend': {
      const s = await spendBreakdown(coId);
      return {
        intent, data: s,
        answer: `Over the last 30 days you spent ${fmt(s.total)}, led by ${s.rows[0] ? `${s.rows[0].category} (${fmt(s.rows[0].amount)}, ${s.rows[0].share}%)` : '—'}.`,
      };
    }
    case 'suggestions': {
      const items = await buildSuggestions(coId, user.role);
      return {
        intent, data: { suggestions: items },
        answer: items.length ? `Here's what I'd focus on today:` : 'Everything looks on track — no urgent action items.',
      };
    }
    case 'greeting':
      return { intent, data: null, answer: `Namaste! I'm KhataOS Assistant. Ask me about cash, payments due, runway, GST, reconciliation, or Tally — or tap a prompt below.` };
    default:
      return {
        intent: 'unknown', data: null,
        answer: `I can answer questions about your cash position, payments due, cash runway, GST & ITC, bank reconciliation, Tally sync, pending approvals, and spend breakdown — all from live platform data. Try one of the prompts.`,
      };
  }
}

// ---- deterministic suggestion engine (role-aware, prioritized) ----
async function buildSuggestionsRule(coId, role) {
  const s = [];
  const failed = (await get(`SELECT COUNT(*) AS c FROM payments WHERE company_id = ? AND status = 'failed'`, [coId])).c;
  if (failed) s.push({ priority: 1, label: `${failed} failed payment${failed === 1 ? '' : 's'} need attention`, action: { type: 'navigate', view: 'payments', filter: 'failed' } });
  const payPending = (await get(`SELECT COUNT(*) AS c FROM payments WHERE company_id = ? AND status = 'pending_approval'`, [coId])).c;
  if (payPending && (role === 'cfo' || role === 'finance_manager')) s.push({ priority: 2, label: `${payPending} payment batch${payPending === 1 ? '' : 'es'} await${payPending === 1 ? 's' : ''} approval`, action: { type: 'navigate', view: 'payments', filter: 'pending_approval' } });
  const overdue = (await get(`SELECT COUNT(*) AS c FROM invoices WHERE company_id = ? AND status IN ('approved','scheduled') AND due_date < ?`, [coId, todayStr()])).c;
  if (overdue) s.push({ priority: 2, label: `${overdue} overdue invoice${overdue === 1 ? '' : 's'} — schedule payment`, action: { type: 'navigate', view: 'payables', filter: 'overdue' } });
  const mine = (await pendingApprovals(coId, role)).length;
  if (mine) s.push({ priority: 3, label: `${mine} invoice${mine === 1 ? '' : 's'} await${mine === 1 ? 's' : ''} your approval`, action: { type: 'navigate', view: 'payables', filter: 'pending_approval' } });
  const mm = (await get(`SELECT COUNT(*) AS c FROM gst_mismatches WHERE company_id = ? AND status = 'open'`, [coId])).c;
  if (mm) s.push({ priority: 3, label: `${mm} GSTR-2B mismatch${mm === 1 ? '' : 'es'} to review`, action: { type: 'navigate', view: 'gst' } });
  const score = await recon.score(coId);
  if (score.accuracy < score.target) s.push({ priority: 4, label: `Recon accuracy ${score.accuracy}% — below ${score.target}% target`, action: { type: 'navigate', view: 'recon' } });
  const tally = await TallyConnector.health(coId);
  const syncMins = minsSince(tally.last_sync_at);
  if (syncMins != null && syncMins > 5) s.push({ priority: 4, label: `Tally sync ${syncMins} min old — check connector`, action: { type: 'navigate', view: 'tally' } });
  const rw = await runwayCalc(coId);
  if (rw.runway_months != null && rw.runway_months < 3) s.push({ priority: 5, label: `Cash runway ${rw.runway_months} months — review outflows`, action: { type: 'navigate', view: 'cash' } });
  return s.sort((a, b) => a.priority - b.priority).slice(0, 6);
}

// Suggestion entry point: LLM when configured, rule engine otherwise.
async function buildSuggestions(coId, role) {
  const fallback = await buildSuggestionsRule(coId, role);
  if (!AI_ENABLED) return fallback;
  try {
    const ctx = await compactContext(coId, role);
    const out = await callLlm(
      [{ role: 'system', content: SUGGEST_PROMPT }, { role: 'user', content: `DATA:\n${JSON.stringify(ctx)}` }],
      260
    );
    const parsed = parseLlm(out);
    if (parsed && parsed.actions.length) {
      return parsed.actions.map((a) => ({ label: a.label, action: { type: 'navigate', view: a.view } }));
    }
  } catch { /* fall through to rule engine */ }
  return fallback;
}

// ---- ask: LLM first (with guardrails), rule engine fallback ----
async function ask(user, question) {
  const coId = user.company_id;
  const intent = detectIntent(question);
  const base = await answerFor(intent, coId, user);
  if (AI_ENABLED && intent !== 'greeting') {
    try {
      const ctx = await compactContext(coId, user.role);
      const out = await callLlm(
        [{ role: 'system', content: SYS_PROMPT }, { role: 'user', content: `DATA:\n${JSON.stringify(ctx)}\n\nQUESTION: ${question}` }],
        450
      );
      const parsed = parseLlm(out);
      if (parsed) {
        return {
          intent: parsed.intent,
          answer: parsed.answer,
          data: base.data,
          suggestions: parsed.actions.map((a) => ({ label: a.label, action: { type: 'navigate', view: a.view } })),
          generative: true,
          prompts: PROMPTS,
          model: DEEPSEEK_MODEL,
        };
      }
    } catch { /* degrade to rule engine */ }
  }
  return {
    intent: base.intent,
    answer: base.answer,
    data: base.data,
    suggestions: await buildSuggestions(coId, user.role),
    generative: false,
    prompts: PROMPTS,
    model: DEEPSEEK_MODEL,
  };
}

const PROMPTS = [
  { label: 'How much cash do we have?', q: 'How much cash do we have?' },
  { label: "What's due this week?", q: "What's due this week?" },
  { label: 'How long is our runway?', q: 'How long is our cash runway?' },
  { label: 'Any GST risks?', q: 'Are there any GST risks or mismatches?' },
  { label: 'Recon status?', q: 'How is bank reconciliation going?' },
  { label: 'What should I focus on?', q: 'What should I focus on today?' },
  { label: 'Where did we spend?', q: 'Where did we spend money last month?' },
  { label: 'Is Tally syncing?', q: 'Is Tally syncing properly?' },
];

function intentStatus() {
  return {
    enabled: AI_ENABLED,
    generative_configured: AI_ENABLED,
    provider: AI_ENABLED ? (DEEPSEEK_URL.includes('deepseek') ? 'deepseek' : 'openai-compatible') : 'deterministic-engine',
    model: AI_ENABLED ? DEEPSEEK_MODEL : null,
    base_url: DEEPSEEK_URL,
    guardrails: ['grounded-in-data', 'no-action-claims', 'scope-refusal', 'view-allowlist', 'json-output-rail'],
  };
}

module.exports = {
  ask,
  buildSuggestions,
  PROMPTS,
  intent_status: intentStatus,
  _internals: { parseLlm, compactContext, VIEWS, detectIntent, AI_ENABLED, DEEPSEEK_MODEL, DEEPSEEK_URL },
};
