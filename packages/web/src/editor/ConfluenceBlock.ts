import { Node, mergeAttributes } from "@tiptap/core";

/**
 * A preserved Confluence block (DESIGN §4.3): a macro, a merged-cell table,
 * a layout — anything Markdown cannot represent. The card shows what it is;
 * the XML inside is never editable (atom), only moved (drag/cut/paste) or
 * deleted. The daemon keeps the byte-exact XML through every save.
 */
export const ConfluenceBlock = Node.create({
  name: "confluenceBlock",
  group: "block",
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      xml: { default: "" },
      label: { default: "Confluence 요소" },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-confluence]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-confluence": "", class: "doc-atom" }),
      ["div", { class: "doc-atom__head" }, "Confluence 요소 · 고정 블록"],
      ["div", { class: "doc-atom__label" }, String(node.attrs.label)],
      ["pre", { class: "doc-atom__xml" }, String(node.attrs.xml)],
    ];
  },
});
