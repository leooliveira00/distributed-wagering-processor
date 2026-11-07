/**
 * Reads one sample from a Prometheus text exposition: the line of `name` whose labels include
 * every given pair (in any order). Returns undefined when no such sample exists.
 */
export function sampleValue(
  text: string,
  name: string,
  labels: Record<string, string> = {},
): number | undefined {
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(.*)\})?\s+(\S+)$/.exec(line);
    if (match?.[1] !== name) continue;
    const labelText = match[3] ?? '';
    if (Object.entries(labels).every(([key, value]) => labelText.includes(`${key}="${value}"`))) {
      return Number(match[4]);
    }
  }
  return undefined;
}
