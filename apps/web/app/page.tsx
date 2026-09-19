"use client";
import { useEffect, useState } from "react";

type Decision = { decisionId: string; createdAt: string; decision: string; wouldHaveDecision?: string; riskClass: string; timing: { totalMs: number }; policy: { version: string }; model?: { usage?: { costUsd?: number } } };
export default function Dashboard() {
  const [items, setItems] = useState<Decision[]>([]);
  const [offline, setOffline] = useState(false);
  useEffect(() => { fetch("/api/decisions").then((r) => r.ok ? r.json() : Promise.reject()).then((x) => setItems(x.data)).catch(() => setOffline(true)); }, []);
  const count = (kind: string) => items.filter((x) => (x.wouldHaveDecision ?? x.decision) === kind).length;
  const spend = items.reduce((total, item) => total + (item.model?.usage?.costUsd ?? 0), 0);
  return <main>
    <section className="hero"><p className="eyebrow">RUNTIME AUTHORIZATION</p><h1>Agent actions, under control.</h1><p>Deterministic policy and semantic evidence for every consequential tool call.</p></section>
    {offline && <div className="notice">API unavailable. Start it with <code>pnpm dev:api</code>.</div>}
    <section className="cards"><article><label>Actions evaluated</label><strong>{items.length}</strong></article><article><label>Allowed</label><strong className="allow">{count("ALLOW")}</strong></article><article><label>Needs review</label><strong className="review">{count("REVIEW")}</strong></article><article><label>Blocked</label><strong className="block">{count("BLOCK")}</strong></article><article><label>Provider spend</label><strong>${spend.toFixed(6)}</strong></article></section>
    <section className="panel"><div className="panelHead"><div><p className="eyebrow">AUDIT TRAIL</p><h2>Recent decisions</h2></div><button onClick={() => location.reload()}>Refresh</button></div>
      <div className="table"><div className="row headings"><span>Time</span><span>Risk</span><span>Decision</span><span>Would have</span><span>Latency</span><span>Policy</span></div>{items.length ? items.map((item) => <div className="row" key={item.decisionId}><span>{new Date(item.createdAt).toLocaleTimeString()}</span><span>{item.riskClass}</span><span><b className={`pill ${item.decision.toLowerCase()}`}>{item.decision}</b></span><span>{item.wouldHaveDecision ?? "—"}</span><span>{item.timing.totalMs.toFixed(0)} ms</span><span>v{item.policy.version}</span></div>) : <div className="empty">No decisions yet. Run the refund demo to create one.</div>}</div>
    </section>
  </main>;
}
