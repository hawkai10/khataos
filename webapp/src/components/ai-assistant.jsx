import { useEffect, useRef, useState } from 'react';
import { Bot, Send, Sparkles, Loader2 } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from './ui/sheet.jsx';
import { Button } from './ui/button.jsx';
import { Input } from './ui/input.jsx';
import { Separator } from './ui/separator.jsx';
import { get, post } from '../lib/api.js';
import { cn } from '../lib/utils.js';

export function AiAssistant({ open, onOpenChange, onNavigate }) {
  const [suggestions, setSuggestions] = useState([]);
  const [messages, setMessages] = useState([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    Promise.all([get('/api/assistant/suggestions'), get('/api/assistant/prompts')])
      .then(([rows, prompts]) => {
        setSuggestions(Array.isArray(rows) ? rows : []);
        setStatus(prompts ? prompts.status : null);
      })
      .catch(() => {
        setSuggestions([]);
        setStatus(null);
      });
  }, [open]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, busy]);

  async function ask(text) {
    const q = String(text || question).trim();
    if (!q || busy) return;
    setMessages((m) => [...m, { role: 'user', text: q }]);
    setQuestion('');
    setBusy(true);
    try {
      const r = await post('/api/assistant/ask', { question: q });
      setMessages((m) => [...m, { role: 'ai', text: r.answer, intent: r.intent, suggestions: r.suggestions }]);
    } catch (e) {
      setMessages((m) => [...m, { role: 'ai', text: 'Sorry — ' + e.message }]);
    } finally {
      setBusy(false);
    }
  }

  function jump(action) {
    if (action && action.view) {
      onNavigate(action.view);
      onOpenChange(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="p-0">
        <SheetHeader className="border-b bg-sidebar text-sidebar-foreground">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/10">
              <Bot className="h-4 w-4" />
            </span>
            <div>
              <SheetTitle className="text-white">KhataOS Copilot</SheetTitle>
              <SheetDescription className="text-sidebar-foreground/60">Answers from your live cash, payables &amp; GST data</SheetDescription>
            </div>
          </div>
        </SheetHeader>

        <div ref={scrollRef} className="slim-scroll flex-1 space-y-3 overflow-y-auto p-4">
          {messages.length === 0 ? (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">Ask anything about your finance operations — cash position, payments due, GST risk, reconciliation, or what to focus on today.</p>
              <Separator className="my-3" />
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Suggested for you</p>
              {suggestions.length ? (
                <div className="flex flex-wrap gap-2">
                  {suggestions.map((s, i) => (
                    <button
                      key={i}
                      onClick={() => ask(s.label.replace(/^[A-Z][a-z]+:\s*/, ''))}
                      className="rounded-full border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            messages.map((m, i) => (
              <div key={i} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                <div
                  className={cn(
                    'max-w-[85%] rounded-xl px-3.5 py-2.5 text-sm leading-relaxed',
                    m.role === 'user' ? 'bg-primary text-primary-foreground' : 'border bg-card text-foreground'
                  )}
                >
                  {m.text}
                  {m.suggestions && m.suggestions.length ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {m.suggestions.map((s, j) => (
                        <button
                          key={j}
                          onClick={() => jump(s.action)}
                          className="rounded-full bg-accent px-2.5 py-1 text-[11px] font-medium text-accent-foreground hover:bg-accent/70"
                        >
                          {s.label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            ))
          )}
          {busy ? (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 rounded-xl border bg-card px-3.5 py-2.5 text-sm text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking…
              </div>
            </div>
          ) : null}
        </div>

        <div className="border-t p-3">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              ask();
            }}
            className="flex gap-2"
          >
            <Input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask about cash, payables, GST…" className="flex-1" />
            <Button type="submit" size="icon" disabled={busy || !question.trim()}>
              <Send className="h-4 w-4" />
            </Button>
          </form>
          <p className="mt-2 flex items-center gap-1 text-[10px] text-muted-foreground">
            <Sparkles className="h-3 w-3" />
            {status && status.enabled
              ? `Engine: ${status.model} (${status.provider}) · grounded in your live data`
              : 'Engine: offline rule engine · set DEEPSEEK_API_KEY in .env to enable the LLM'}
          </p>
        </div>
      </SheetContent>
    </Sheet>
  );
}
