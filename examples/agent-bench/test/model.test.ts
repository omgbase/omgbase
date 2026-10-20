// ClaudeModel against a fake client: the request it sends (two cache breakpoints,
// the caller's messages untouched) and the credential-error classifier the bench's
// fail-fast rests on. No API spend.
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { ClaudeModel, isCredentialError, withCacheBreakpoint, type MessagesClient } from "../src/model.ts";

const EPHEMERAL = { type: "ephemeral" };

function breakpoints(v: unknown): number {
  return (JSON.stringify(v).match(/"cache_control":\{"type":"ephemeral"\}/g) ?? []).length;
}

const REPLY = {
  id: "msg_fake", type: "message", role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "ok", citations: null }],
  stop_reason: "end_turn", stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: null, service_tier: null },
} as unknown as Anthropic.Message;

function fakeClient(): { client: MessagesClient; sent: Anthropic.MessageCreateParamsNonStreaming[] } {
  const sent: Anthropic.MessageCreateParamsNonStreaming[] = [];
  return { sent, client: { messages: { create: (params) => { sent.push(params); return Promise.resolve(REPLY); } } } };
}

const TURN_ONE: Anthropic.MessageParam[] = [{ role: "user", content: "Set verified: true on the stone." }];

const TURN_THREE: Anthropic.MessageParam[] = [
  { role: "user", content: "Set verified: true on the stone." },
  { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "tool_use", id: "toolu_1", name: "plan", input: {} }, { type: "tool_use", id: "toolu_2", name: "docs_read", input: { _path: "/index.md" } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "{}" }, { type: "tool_result", tool_use_id: "toolu_2", content: "{\"_raw\":\"# Alchemy\"}", is_error: true }] },
];

describe("ClaudeModel's request", () => {
  it("turn 1: a breakpoint on the system block and one on the prompt's text block — two in all", async () => {
    const { client, sent } = fakeClient();
    const model = new ClaudeModel({ client });
    const before = structuredClone(TURN_ONE);
    await model.complete({ system: "sys", tools: [], messages: TURN_ONE });
    const req = sent[0]!;
    expect(req.system).toEqual([{ type: "text", text: "sys", cache_control: EPHEMERAL }]);
    expect(req.messages).toEqual([{ role: "user", content: [{ type: "text", text: "Set verified: true on the stone.", cache_control: EPHEMERAL }] }]);
    expect(breakpoints(req)).toBe(2);
    expect(req).toMatchObject({ model: "claude-opus-5", thinking: { type: "adaptive" }, output_config: { effort: "high" }, max_tokens: 16000 });
    expect(TURN_ONE).toEqual(before);
  });

  it("a later turn: the breakpoint moves to the last tool_result; the earlier blocks carry none; the caller's array is not mutated", async () => {
    const { client, sent } = fakeClient();
    const model = new ClaudeModel({ client, provider: "bedrock", model: "claude-opus-5", effort: "low" });
    const before = structuredClone(TURN_THREE);
    await model.complete({ system: "sys", tools: [], messages: TURN_THREE });
    const req = sent[0]!;
    expect(req.model).toBe("global.anthropic.claude-opus-5");
    expect(breakpoints(req)).toBe(2);
    const last = req.messages[2]!.content as Anthropic.ContentBlockParam[];
    expect(last[0]).toEqual({ type: "tool_result", tool_use_id: "toolu_1", content: "{}" });
    expect(last[1]).toEqual({ type: "tool_result", tool_use_id: "toolu_2", content: "{\"_raw\":\"# Alchemy\"}", is_error: true, cache_control: EPHEMERAL });
    expect(breakpoints(req.messages[1])).toBe(0);
    // the original: same shape as before the call, the last message copied rather than touched
    expect(TURN_THREE).toEqual(before);
    expect(req.messages[2]).not.toBe(TURN_THREE[2]);
    expect(req.messages[2]!.content).not.toBe(TURN_THREE[2]!.content);
    expect(req.messages[0]).toBe(TURN_THREE[0]);
  });

  it("withCacheBreakpoint leaves an empty conversation and a redacted_thinking tail alone", () => {
    expect(withCacheBreakpoint([])).toEqual([]);
    const redacted: Anthropic.MessageParam[] = [{ role: "assistant", content: [{ type: "redacted_thinking", data: "x" }] }];
    expect(withCacheBreakpoint(redacted)).toBe(redacted);
    const empty: Anthropic.MessageParam[] = [{ role: "user", content: [] }];
    expect(withCacheBreakpoint(empty)).toBe(empty);
  });
});

describe("isCredentialError", () => {
  const body = (type: string, message: string) => ({ type: "error", error: { type, message } });

  it("recognizes the Anthropic API's 401 and 403", () => {
    const unauthorized = Anthropic.APIError.generate(401, body("authentication_error", "invalid x-api-key"), undefined, new Headers());
    expect(unauthorized).toBeInstanceOf(Anthropic.AuthenticationError);
    expect(isCredentialError(unauthorized)).toBe(true);
    expect(isCredentialError(Anthropic.APIError.generate(403, body("permission_error", "no access to this model"), undefined, new Headers()))).toBe(true);
  });

  it("recognizes the Bedrock SDK's credential-chain failure, with the AWS cause (an expired SSO token) underneath", () => {
    const sso = new Error("Token is expired. To refresh this SSO session run 'aws sso login' with the corresponding profile.");
    const chain = new Anthropic.APIConnectionError({ message: "Failed to resolve AWS credentials from the credential provider chain.", cause: sso });
    expect(isCredentialError(chain)).toBe(true);
    expect(isCredentialError(sso)).toBe(true);
    expect(isCredentialError(new Error("wrapped", { cause: new Error("Could not load credentials from any providers") }))).toBe(true);
    expect(isCredentialError(new Error("The security token included in the request is expired"))).toBe(true);
  });

  it("lets every other failure through", () => {
    expect(isCredentialError(Anthropic.APIError.generate(500, body("api_error", "overloaded"), undefined, new Headers()))).toBe(false);
    expect(isCredentialError(Anthropic.APIError.generate(429, body("rate_limit_error", "slow down"), undefined, new Headers()))).toBe(false);
    expect(isCredentialError(new Anthropic.APIConnectionError({ message: "Connection error." }))).toBe(false);
    expect(isCredentialError(new Error("boom"))).toBe(false);
    expect(isCredentialError("not even an error")).toBe(false);
  });
});
