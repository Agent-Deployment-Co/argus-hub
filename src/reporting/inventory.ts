import type { PluginInfo } from "../types.ts";

// Hub runs as a server — it has no local Claude plugin installation to inspect.
// Return an empty map so the byPlugin dashboard section is omitted cleanly.
export function loadPlugins(): Map<string, PluginInfo> {
  return new Map();
}

export function skillPlugin(skill: string, plugins: Map<string, PluginInfo>): string | null {
  const ns = skill.includes(":") ? skill.split(":")[0]! : null;
  if (ns && plugins.has(ns)) return ns;
  return null;
}
