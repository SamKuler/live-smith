import createDOMPurify from "dompurify";
import { Marked, Renderer } from "marked";

declare global {
  interface Window {
    LiveSmithMarkdown?: {
      renderInto(target: Element, source: string): void;
    };
  }
}

const allowedTags = [
  "a",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
];
const renderer = new Renderer();
// Raw HTML and remote images stay visible as inert text instead of becoming DOM.
renderer.html = ({ text }) => escapeHtml(text);
renderer.image = ({ text }) => escapeHtml(text);

const markdown = new Marked({
  async: false,
  breaks: false,
  gfm: true,
  renderer,
});
const purifier = createDOMPurify(window);

function renderInto(target: Element, source: string): void {
  const parsed = markdown.parse(
    String(source || "").replace(/^[\u200B-\u200F\uFEFF]/, ""),
  );
  if (typeof parsed !== "string") {
    throw new Error("Markdown renderer unexpectedly returned an asynchronous result.");
  }
  const fragment = purifier.sanitize(parsed, {
    ALLOWED_ATTR: ["class", "href", "title"],
    ALLOWED_TAGS: allowedTags,
    ALLOWED_URI_REGEXP: /^(?:https?:\/\/|mailto:)/i,
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
    SANITIZE_NAMED_PROPS: true,
  });

  secureExternalLinks(fragment);
  wrapTablesForScrolling(fragment);
  removeEmptyRootTextNodes(fragment);

  target.replaceChildren(fragment);
  target.classList.add("markdown-body");
}

function secureExternalLinks(fragment: DocumentFragment): void {
  for (const link of fragment.querySelectorAll("a")) {
    if (!link.hasAttribute("href")) {
      link.replaceWith(...link.childNodes);
      continue;
    }
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
}

function wrapTablesForScrolling(fragment: DocumentFragment): void {
  for (const table of [...fragment.querySelectorAll("table")]) {
    const scrollContainer = table.ownerDocument.createElement("div");
    scrollContainer.className = "markdown-table-scroll";
    table.replaceWith(scrollContainer);
    scrollContainer.append(table);
  }
}

function removeEmptyRootTextNodes(fragment: DocumentFragment): void {
  for (const node of [...fragment.childNodes]) {
    if (node.nodeType === 3 && !node.textContent?.trim()) node.remove();
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

window.LiveSmithMarkdown = { renderInto };
