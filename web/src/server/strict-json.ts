// JSON.parse alone loses duplicate keys, making retained evidence ambiguous.
export function parseStrictJson(raw: string): unknown {
  const value: unknown = JSON.parse(raw);
  const tokens = /"(?:\\[\s\S]|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:"]+/g;
  const stack: { object: boolean; expectingKey: boolean; keys: Set<string> }[] = [];
  let token: RegExpExecArray | null;
  while ((token = tokens.exec(raw))) {
    const text = token[0], current = stack.at(-1);
    if (text === "{" || text === "[") {
      if (stack.length >= 64) throw new Error("JSON_DEPTH_EXCEEDED");
      stack.push({ object: text === "{", expectingKey: text === "{", keys: new Set() });
    } else if (text === "}" || text === "]") stack.pop();
    else if (text === "," && current?.object) current.expectingKey = true;
    else if (text[0] === '"' && current?.object && current.expectingKey) {
      const key = JSON.parse(text) as string;
      if (current.keys.has(key)) throw new Error("DUPLICATE_JSON_KEY");
      current.keys.add(key);
      current.expectingKey = false;
    }
  }
  return value;
}
