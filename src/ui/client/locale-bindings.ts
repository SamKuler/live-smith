export type LocalizedText = string | (() => string);

/** Tracks only application-owned text, leaving authored content and form values intact. */
export function createLocaleBindings() {
  const bindings = new WeakMap<Element, Map<string, () => string>>();
  let locale = document.documentElement.lang;
  function bind(node: Element, property: string, value: LocalizedText) {
    let entries = bindings.get(node);
    if (typeof value === "function") {
      if (!entries) { entries = new Map(); bindings.set(node, entries); }
      entries.set(property, value);
    } else entries?.delete(property);
    apply(node, property, typeof value === "function" ? value() : value);
  }
  function apply(node: Element, property: string, value: string) {
    if (property === "textContent") {
      if (node.textContent !== value) node.textContent = value;
    } else if (node.getAttribute(property) !== value) node.setAttribute(property, value);
  }
  return {
    text: (node: Element, value: LocalizedText) => bind(node, "textContent", value),
    attribute: (node: Element, name: string, value: LocalizedText) => bind(node, name, value),
    refresh(root: Element): boolean {
      const next = document.documentElement.lang;
      if (locale === next) return false;
      locale = next;
      for (const node of [root, ...root.querySelectorAll("*")]) {
        for (const [property, value] of bindings.get(node) ?? []) apply(node, property, value());
      }
      return true;
    },
  };
}

window.LiveSmithFactories = window.LiveSmithFactories || {};
window.LiveSmithFactories.createLocaleBindings = createLocaleBindings;
