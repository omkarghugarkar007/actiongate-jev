import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "ActionGate — AI Agent Authorization with TypeSafe Jev",
  description: "Runtime authorization and guardrails for AI-agent tool calls using deterministic policy and TypeSafe Jev through OpenRouter.",
  keywords: ["TypeSafe Jev", "OpenRouter", "AI agent authorization", "agent security", "tool calling", "AI guardrails"]
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><header><a className="brand" href="/">ActionGate <span>console</span></a><div className="status"><i /> Development</div></header>{children}</body></html>;
}
