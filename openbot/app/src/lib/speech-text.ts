import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

type Node = {
  type: string;
  value?: string;
  alt?: string | null;
  url?: string;
  children?: Node[];
};

/** Speak visible prose, with pauses between blocks; omit markup, URLs and fenced code. */
export function speechText(markdown: string): string {
  const tree = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  function read(node: Node): string {
    switch (node.type) {
      case "html":
        return /^<br\s*\/?\s*>$/i.test(node.value ?? "") ? "\n" : "";
      case "code":
      case "definition":
      case "footnoteDefinition":
      case "footnoteReference":
        return "";
      case "image":
      case "imageReference":
        return node.alt ?? "";
      case "link": {
        const label = (node.children ?? []).map(read).join("");
        return label === node.url || label === node.url?.replace(/^mailto:/, "")
          ? ""
          : label;
      }
      case "text":
      case "inlineCode":
        return node.value ?? "";
      case "break":
      case "thematicBreak":
        return "\n";
      default: {
        const blocks = [
          "root",
          "blockquote",
          "list",
          "listItem",
          "table",
          "tableRow",
        ];
        return (node.children ?? [])
          .map(read)
          .join(blocks.includes(node.type) ? "\n" : "");
      }
    }
  }
  return read(tree)
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}
