"use client";
import { useEffect, useMemo, useState } from "react";

type Reason = { code: string; message: string; source: string };
type Decision = {
  decisionId: string; createdAt: string; decision: string; wouldHaveDecision?: string;
  riskClass: string; reasons?: Reason[]; timing: { totalMs: number }; policy: { version: string };
  model?: { resolvedModel?: string; usage?: { costUsd?: number } };
};

/**
 * The evidence loop: what agents tried, what was refused, and why.
 *
 * Blocking is invisible when nothing goes wrong, so a dashboard that only counts
 * decisions gives an operator no reason to look at it. What earns a second visit
 * is the refusal list — the actions that were proposed and stopped.
 */
export default function Dashboard() {
  const [items, setItems] = useState<Decision[]>([]);
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/decisions")
      .then((response) => (response.ok ? response.json() : Promise.reject()))
      .then((body) => setItems(body.data ?? []))
      .catch(() => setOffline(true))
      .finally(() => setLoading(false));
  }, []);

  const effective = (item: Decision) => item.wouldHaveDecision ?? item.decision;
  const count = (kind: string) => items.filter((item) => effective(item) === kind).length;
  const spend = items.reduce((total, item) => total + (item.model?.usage?.costUsd ?? 0), 0);

  // Why actions were refused, most common first. This is the part an operator
  // acts on: a spike in one reason is a policy or prompt problem, not noise.
  const refusals = useMemo(() => {
    const tally = new Map<string, { code: string; message: string; source: string; count: number }>();
    for (const item of items) {
      if (effective(item) === "ALLOW") continue;
      for (const reason of item.reasons ?? []) {
        const existing = tally.get(reason.code);
        if (existing) existing.count += 1;
        else tally.set(reason.code, { ...reason, count: 1 });
      }
    }
    return [...tally.values()].sort((a, b) => b.count - a.count);
  }, [items]);

  const byRisk = useMemo(() => {
    const tally = new Map<string, { risk: string; total: number; refused: number }>();
    for (const item of items) {
      const entry = tally.get(item.riskClass) ?? { risk: item.riskClass, total: 0, refused: 0 };
      entry.total += 1;
      if (effective(item) !== "ALLOW") entry.refused += 1;
      tally.set(item.riskClass, entry);
    }
    return [...tally.values()].sort((a, b) => b.refused - a.refused || b.total - a.total);
  }, [items]);

  return <main>
    <section className="hero">
      <p className="eyebrow">RUNTIME AUTHORIZATION</p>
      <h1>Agent actions, under control.</h1>
      <p>What your agents proposed, what was refused, and why.</p>
    </section>

    {offline && <div className="notice">API unavailable. Start it with <code>pnpm dev:api</code>.</div>}

    <section className="cards">
      <article><label>Actions evaluated</label><strong>{items.length}</strong></article>
      <article><label>Allowed</label><strong className="allow">{count("ALLOW")}</strong></article>
      <article><label>Needs review</label><strong className="review">{count("REVIEW")}</strong></article>
      <article><label>Blocked</label><strong className="block">{count("BLOCK")}</strong></article>
      <article><label>Provider spend</label><strong>${spend.toFixed(6)}</strong></article>
    </section>

    <section className="panel">
      <div className="panelHead"><div><p className="eyebrow">EVIDENCE</p><h2>Why actions were refused</h2></div>
        <a className="ghost" href="/simulator">Try a decision →</a></div>
      <div className="table">
        <div className="row headings threeCol"><span>Reason</span><span>Decided by</span><span>Times</span></div>
        {refusals.length
          ? refusals.map((reason) => <div className="row threeCol" key={reason.code}>
              <span><code>{reason.code}</code><em>{reason.message}</em></span>
              <span>{reason.source === "JEV" ? "meaning" : reason.source === "DETERMINISTIC" ? "rules" : "system"}</span>
              <span><b>{reason.count}</b></span>
            </div>)
          : <div className="empty">{loading ? "Loading…" : "Nothing has been refused yet. Run pnpm refund:demo, or try the simulator."}</div>}
      </div>
    </section>

    <section className="panel">
      <div className="panelHead"><div><p className="eyebrow">EVIDENCE</p><h2>Refusal rate by risk class</h2></div></div>
      <div className="table">
        <div className="row headings threeCol"><span>Risk class</span><span>Evaluated</span><span>Refused</span></div>
        {byRisk.length
          ? byRisk.map((entry) => <div className="row threeCol" key={entry.risk}>
              <span>{entry.risk}</span><span>{entry.total}</span>
              <span><b className={entry.refused ? "review" : ""}>{entry.refused}</b>{entry.total ? ` (${Math.round((entry.refused / entry.total) * 100)}%)` : ""}</span>
            </div>)
          : <div className="empty">{loading ? "Loading…" : "No decisions yet."}</div>}
      </div>
    </section>

    <section className="panel">
      <div className="panelHead"><div><p className="eyebrow">AUDIT TRAIL</p><h2>Recent decisions</h2></div>
        <button onClick={() => location.reload()}>Refresh</button></div>
      <div className="table">
        <div className="row headings"><span>Time</span><span>Risk</span><span>Decision</span><span>Would have</span><span>Latency</span><span>Policy</span></div>
        {items.length
          ? items.map((item) => <div className="row" key={item.decisionId}>
              <span>{new Date(item.createdAt).toLocaleTimeString()}</span>
              <span>{item.riskClass}</span>
              <span><b className={`pill ${item.decision.toLowerCase()}`}>{item.decision}</b></span>
              <span>{item.wouldHaveDecision ?? "—"}</span>
              <span>{item.timing.totalMs.toFixed(0)} ms</span>
              <span>v{item.policy.version}</span>
            </div>)
          : <div className="empty">{loading ? "Loading…" : "No decisions yet. Run the refund demo to create one."}</div>}
      </div>
    </section>
  </main>;
}
