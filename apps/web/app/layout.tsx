import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  applicationName: "ActionGate",
  title: { default: "ActionGate — Jev Tool-Calling Authorization", template: "%s | ActionGate" },
  description: "Open-source runtime authorization for AI-agent tool calls using deterministic policy, single-use permits, and TypeSafe Jev through OpenRouter.",
  keywords: ["Jev", "TypeSafe Jev", "Jev tool calling", "OpenRouter Jev", "AI agent tool calling", "AI agent authorization", "agent security", "MCP security", "AI guardrails"],
  authors: [{ name: "Omkar Ghugarkar", url: "https://github.com/omkarghugarkar007" }],
  creator: "Omkar Ghugarkar",
  category: "developer tools",
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    title: "ActionGate — Jev Tool-Calling Authorization",
    description: "Turn TypeSafe Jev evidence into exact-action, expiring, single-use permits for AI-agent tool calls.",
    url: "https://github.com/omkarghugarkar007/actiongate-jev",
    siteName: "ActionGate"
  },
  twitter: {
    card: "summary_large_image",
    title: "ActionGate — Jev Tool-Calling Authorization",
    description: "Runtime authorization and single-use permits for AI-agent tool calls with TypeSafe Jev."
  }
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "SoftwareSourceCode",
    name: "ActionGate",
    description: "Open-source Jev tool-calling authorization gateway for AI agents.",
    codeRepository: "https://github.com/omkarghugarkar007/actiongate-jev",
    programmingLanguage: ["TypeScript", "Python"],
    license: "https://www.apache.org/licenses/LICENSE-2.0",
    author: { "@type": "Person", name: "Omkar Ghugarkar", url: "https://github.com/omkarghugarkar007" }
  };
  return <html lang="en"><body><script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }} /><header><a className="brand" href="/">ActionGate <span>console</span></a><div className="status"><i /> Development</div></header>{children}</body></html>;
}
