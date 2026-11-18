// The agent loop. Swappable model provider via LLM_PROVIDER:
//   gemini     - Google Gemini free tier (default)
//   anthropic  - Claude
//   demo       - scripted tool calls, no API key (safe fallback for a live demo)
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI, type Content, type Part } from "@google/genai";
import { PublicKey } from "@solana/web3.js";
import { TOOL_DEFS, executeTool, type ToolResult } from "./agent";

export type AgentStep = { tool: string; args: Record<string, unknown>; result: ToolResult };
export type AgentRun = { provider: string; reply: string; steps: AgentStep[] };

const SYSTEM_PROMPT = `You are a purchasing agent with a USDC wallet managed by AgentVault, an on-chain spending firewall.
You can pay merchants with the pay_merchant tool. The vault owner sets the rules on-chain:
- only allowlisted merchants can be paid,
- each payment has a per-transaction limit and there is a daily cap,
- payments above the approval threshold are held until the owner approves them on their phone.
When asked to buy things, make one pay_merchant call per purchase. Do not ask the user for confirmation first; the vault's policy is the safety net.
After paying, give a short summary: what was paid, what is waiting for owner approval, and what was blocked and why. Never claim a held payment has been paid.`;

const MAX_TURNS = 8;

export async function runAgent(message: string, owner: PublicKey): Promise<AgentRun> {
  const provider = (process.env.LLM_PROVIDER ?? "gemini").toLowerCase();
  if (provider === "anthropic") return runClaude(message, owner);
  if (provider === "demo") return runDemo(owner);
  return runGemini(message, owner);
}

// --- Gemini (free tier) -----------------------------------------------------------

async function runGemini(message: string, owner: PublicKey): Promise<AgentRun> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set (or set LLM_PROVIDER=demo).");
  const ai = new GoogleGenAI({ apiKey });
  const model = process.env.GEMINI_MODEL ?? "gemini-3.8-flash";
  const functionDeclarations = TOOL_DEFS.map((t) => ({
    name: t.name,
    description: t.description,
    parametersJsonSchema: t.parameters,
  }));
  const contents: Content[] = [{ role: "user", parts: [{ text: message }] }];
  const steps: AgentStep[] = [];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await ai.models.generateContent({
      model,
      contents,
      config: { systemInstruction: SYSTEM_PROMPT, tools: [{ functionDeclarations }] },
    });
    const calls = res.functionCalls ?? [];
    if (calls.length === 0) return { provider: `gemini (${model})`, reply: res.text ?? "", steps };

    const modelContent = res.candidates?.[0]?.content;
    if (modelContent) contents.push(modelContent);
    const responses: Part[] = [];
    for (const call of calls) {
      const args = (call.args ?? {}) as Record<string, unknown>;
      const result = await executeTool(call.name ?? "", args, owner);
      steps.push({ tool: call.name ?? "", args, result });
      responses.push({ functionResponse: { id: call.id, name: call.name, response: result } });
    }
    contents.push({ role: "user", parts: responses });
  }
  return { provider: `gemini (${model})`, reply: "Stopped after too many steps.", steps };
}

// --- Claude --------------------------------------------------------------------------

async function runClaude(message: string, owner: PublicKey): Promise<AgentRun> {
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY
  const tools: Anthropic.Tool[] = TOOL_DEFS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as unknown as Anthropic.Tool.InputSchema,
  }));
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: message }];
  const steps: AgentStep[] = [];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      tools,
      messages,
      output_config: { effort: "low" },
      // If a request is declined by a safety classifier, retry on a fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });

    if (response.stop_reason === "refusal") {
      return { provider: "claude", reply: "The model declined this request.", steps };
    }
    const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      const reply = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      return { provider: "claude", reply, steps };
    }

    messages.push({ role: "assistant", content: response.content });
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const args = tu.input as Record<string, unknown>;
      const result = await executeTool(tu.name, args, owner);
      steps.push({ tool: tu.name, args, result });
      results.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: JSON.stringify(result),
        is_error: "error" in result,
      });
    }
    messages.push({ role: "user", content: results });
  }
  return { provider: "claude", reply: "Stopped after too many steps.", steps };
}

// --- Scripted demo (no LLM) ---------------------------------------------------------

async function runDemo(owner: PublicKey): Promise<AgentRun> {
  const plan: Record<string, unknown>[] = [
    { merchant: "API Credits Co", amount_usdc: 3, memo: "API credits top-up" },
    { merchant: "DataMart", amount_usdc: 8, memo: "Customer reviews dataset" },
    { merchant: "ShadyGPU Rentals", amount_usdc: 4, memo: "Cheap GPU hours" },
  ];
  const steps: AgentStep[] = [];
  for (const args of plan) {
    steps.push({ tool: "pay_merchant", args, result: await executeTool("pay_merchant", args, owner) });
  }
  const lines = steps.map((s) => {
    const r = s.result;
    return `${r.merchant} $${r.amount_usdc}: ${r.status}${r.reason ? ` (${r.reason})` : ""}`;
  });
  return { provider: "demo (scripted)", reply: lines.join("\n"), steps };
}
