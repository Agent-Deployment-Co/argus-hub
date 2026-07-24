import { spawn } from "node:child_process";
import type { ExecuteCommand, LlmResult, ProviderDescriptor } from "../types.ts";

export const MAX_COMMAND_OUTPUT_BYTES = 32 * 1024 * 1024;

export function splitCommand(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const char of command.trim()) {
    if (escaped) { current += char; escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = null; else current += char; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (/\s/.test(char)) { if (current) { args.push(current); current = ""; } continue; }
    current += char;
  }
  if (escaped) current += "\\";
  if (quote) throw new Error("unterminated quote");
  if (current) args.push(current);
  return args;
}

export const executeCommand: ExecuteCommand = async (command, input, signal) => {
  let argv: string[];
  try {
    argv = splitCommand(command);
  } catch (error) {
    return { ok: false, text: "", error: error instanceof Error ? error.message : String(error) };
  }
  if (!argv.length) return { ok: false, text: "", error: "no command configured" };
  return new Promise<LlmResult>((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ["pipe", "pipe", "pipe"], signal });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= MAX_COMMAND_OUTPUT_BYTES) stdout += chunk.toString("utf8");
      else child.kill();
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8").slice(0, 2000); });
    child.stdin.on("error", () => {});
    child.stdin.end(input, "utf8");
    child.on("error", (error) => resolve({ ok: false, text: "", error: error.message }));
    child.on("close", (code) => resolve(bytes > MAX_COMMAND_OUTPUT_BYTES
      ? { ok: false, text: "", error: "provider output exceeded buffer limit", status: code }
      : code === 0 && stdout.trim()
        ? { ok: true, text: stdout, status: code }
        : { ok: false, text: "", error: stderr.trim() || `exited with status ${code}`, status: code }));
  });
};

export const commandProvider: ProviderDescriptor = {
  name: "command",
  label: "Command",
  description: "Executes an administrator-configured command on the Hub host.",
  configFields: ["command"],
  complete: (call) => (call.executeCommand ?? executeCommand)(
    call.command ?? "",
    call.system ? `${call.system}\n\n${call.prompt}` : call.prompt,
    call.signal,
  ),
};
