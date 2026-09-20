"use client";
import { useRef, useState } from "react";

type Reason = { code: string; message: string; source: string };
type Simulation = {
  decision?: string;
  riskClass?: string;
  reasons?: Reason[];
  timing?: { totalMs: number };
  note?: string;
  error?: { code: string };
};

const PRESETS: Record<string, { label: string; intent: string; tool: string; operation: string; risk: string; args: string }> = {
  supported: {
    label: "What the user asked for",
    intent: "Refund the duplicate $49 charge on txn_5512.",
    tool: "refund_payment", operation: "refund", risk: "FINANCIAL",
    args: '{\n  "transactionId": "txn_5512",\n  "amountCents": 4900\n}'
  },
  targetSwap: {
    label: "A different transaction",
    intent: "Refund the duplicate $49 charge on txn_5512.",
    tool: "refund_payment", operation: "refund", risk: "FINANCIAL",
    args: '{\n  "transactionId": "txn_9981",\n  "amountCents": 4900\n}'
  },
  question: {
    label: "A question, not a request",
    intent: "Why was I charged twice for txn_5512?",
    tool: "refund_payment", operation: "refund", risk: "FINANCIAL",
    args: '{\n  "transactionId": "txn_5512",\n  "amountCents": 4900\n}'
  }
};

export default function Simulator() {
  const [preset, setPreset] = useState("supported");
  const [intent, setIntent] = useState(PRESETS.supported!.intent);
  const [args, setArgs] = useState(PRESETS.supported!.args);
  const [result, setResult] = useState<Simulation | null>(null);
  const [busy, setBusy] = useState(false);
  const resultRef = useRef<HTMLElement | null>(null);

  const choose = (key: string) => {
    const chosen = PRESETS[key]!;
    setPreset(key);
    setIntent(chosen.intent);
    setArgs(chosen.args);
    setResult(null);
  };

  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      const chosen = PRESETS[preset]!;
      const response = await fetch("/api/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request: {
            actor: { agentId: "simulator" },
            userIntent: { text: intent, source: "user_message" },
            proposedAction: { tool: chosen.tool, operation: chosen.operation, arguments: JSON.parse(args), riskClass: chosen.risk },
            deterministicFacts: { authenticated: true, authorizedByRbac: true, duplicate: false, amountCents: 4900, currency: "USD" }
          }
        })
      });
      setResult(await response.json());
      // Scroll the verdict into view; a decision below the fold is a decision nobody sees.
      requestAnimationFrame(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }));
    } catch {
      setResult({ error: { code: "INVALID_ARGUMENTS" } });
    } finally {
      setBusy(false);
    }
  };

  return <main>
    <section className="hero">
      <p className="eyebrow">SIMULATOR</p>
      <h1>Try a decision.</h1>
      <p>Runs the full decision path and throws the result away.</p>
    </section>

    <section className="panel">
      <div className="panelHead"><div><p className="eyebrow">PROPOSED ACTION</p><h2>Same tool, different meaning</h2></div></div>
      <div className="simPanel">
      <div className="presets">
        {Object.entries(PRESETS).map(([key, value]) =>
          <button key={key} className={key === preset ? "active" : ""} onClick={() => choose(key)}>{value.label}</button>)}
      </div>
      <label className="field"><span>What the user said</span>
        <textarea value={intent} onChange={(event) => setIntent(event.target.value)} rows={2} />
      </label>
      <label className="field"><span>Arguments the agent proposed</span>
        <textarea value={args} onChange={(event) => setArgs(event.target.value)} rows={5} spellCheck={false} />
      </label>
      <button className="primary" onClick={run} disabled={busy}>{busy ? "Deciding…" : "Simulate"}</button>
      </div>
    </section>

    {result && <section className="panel" ref={resultRef}>
      <div className="panelHead"><div><p className="eyebrow">RESULT</p><h2>Decision</h2></div></div>
      {result.error
        ? <div className="simPanel"><div className="notice">Could not simulate: {result.error.code}. Start the API with <code>pnpm dev:api</code>.</div></div>
        : <>
            <div className="verdict">
              <b className={`pill ${String(result.decision).toLowerCase()}`}>{result.decision}</b>
              {result.timing && <span className="muted">decided in {result.timing.totalMs.toFixed(0)} ms · nothing stored, no grant issued</span>}
            </div>
            <div className="table reasons">
              <div className="row headings"><span>Reason</span><span>Source</span><span>Explanation</span></div>
              {(result.reasons ?? []).map((reason) =>
                <div className="row" key={reason.code}><span><code>{reason.code}</code></span><span>{reason.source}</span><span>{reason.message}</span></div>)}
            </div>
          </>}
    </section>}
  </main>;
}
