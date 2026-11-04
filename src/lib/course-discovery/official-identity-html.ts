import { parse, serialize, type DefaultTreeAdapterMap } from "parse5";

/** Preserve small native documents byte-for-byte. For a script-heavy document
 * already bounded by the native document transport, remove only inert payloads
 * before identity parsing. Never truncate retained markup or use this as proof
 * of visibility, identity, source ownership, or availability. */
export function officialIdentityHtml(bytes: Buffer): string | undefined {
  if (bytes.length > 2_000_000) return undefined;
  const html = bytes.toString("utf8");
  if (bytes.length <= 600_000) return html;
  try {
    const document = parse(html);
    type Node = DefaultTreeAdapterMap["node"];
    const stack: Array<{ node: Node; depth: number }> = [{ node: document, depth: 0 }];
    let count = 0;
    while (stack.length) {
      const { node, depth } = stack.pop()!;
      if (++count > 20_000 || depth > 128) return undefined;
      if (!("childNodes" in node)) continue;
      node.childNodes = node.childNodes.filter(child => {
        if (child.nodeName === "#comment") return false;
        if (!("tagName" in child)) return true;
        if (["style", "noscript", "template"].includes(child.tagName)) return false;
        return child.tagName !== "script" || child.attrs.some(attr => attr.name === "type" && attr.value.toLowerCase() === "application/ld+json");
      });
      for (const child of node.childNodes) stack.push({ node: child, depth: depth + 1 });
    }
    const compact = serialize(document);
    return Buffer.byteLength(compact, "utf8") <= 600_000 ? compact : undefined;
  } catch { return undefined; }
}
