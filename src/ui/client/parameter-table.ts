import { createLocaleBindings, type LocalizedText } from "./locale-bindings.js";
import { sameParameterNumber } from "../../agent/device-parameter-contracts.js";

export interface ParameterTableRow { index: number; name: string; before?: number; after?: number; min: number; max: number; state?: string }

/** A complete read-only table; filtering changes visibility, never saved values. */
export function createParameterTable() {
  const bindings = createLocaleBindings();
  const t = (source: string, values?: Record<string, string>) => window.LiveSmithI18n?.t(source, values) ?? source;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: LocalizedText) => {
    const result = document.createElement(tag); if (text !== undefined) bindings.text(result, text); return result;
  };
  const root = node("section"); root.className = "parameter-table-view";
  const filterLabel = node("label"); filterLabel.append(node("span", () => t("Filter parameters")));
  const filter = node("input"); filter.type = "search"; filterLabel.append(filter);
  const changesLabel = node("label"); changesLabel.className = "parameter-changes-filter";
  const changes = node("input"); changes.type = "checkbox"; changesLabel.append(changes, node("span", () => t("Only changed parameters")));
  const count = node("p"); count.className = "field-hint"; count.setAttribute("role", "status");
  const scroller = node("div"); scroller.className = "parameter-table-scroll"; scroller.tabIndex = 0;
  bindings.attribute(scroller, "aria-label", () => t("Device parameter values"));
  const table = node("table"); const head = node("thead"); const heading = node("tr");
  const beforeHeading = node("th"); const afterHeading = node("th");
  heading.append(node("th", () => t("Parameter")), beforeHeading, afterHeading, node("th", () => t("Range")));
  for (const th of heading.querySelectorAll("th")) th.scope = "col";
  head.append(heading); const body = node("tbody"); table.append(head, body); scroller.append(table);
  root.append(filterLabel, changesLabel, count, scroller);
  let rows: readonly ParameterTableRow[] = [];
  let beforeLabel = "Current value", afterLabel = "Saved value";
  function render() {
    const comparing = rows.some((row) => row.before !== undefined);
    beforeHeading.hidden = changesLabel.hidden = !comparing;
    if (!comparing) changes.checked = false;
    const query = filter.value.trim().toLocaleLowerCase();
    const visible = rows.filter((row) => (!query || `${row.index} ${row.name}`.toLocaleLowerCase().includes(query)) &&
      (!changes.checked || row.before !== undefined && row.after !== undefined && !sameParameterNumber(row.before, row.after)));
    bindings.text(beforeHeading, () => t(beforeLabel)); bindings.text(afterHeading, () => t(afterLabel));
    bindings.text(count, () => visible.length === rows.length ? t("{count} parameters", { count: String(rows.length) })
      : t("{shown} of {total} parameters", { shown: String(visible.length), total: String(rows.length) }));
    body.replaceChildren(...visible.map((row) => {
      const tr = node("tr");
      const name = node("th", `[${row.index}] ${row.name}`); name.scope = "row";
      if (row.state) { const state = node("span", () => t(row.state!)); state.className = "parameter-row-state"; name.append(state); }
      tr.dataset.changed = String(row.before !== undefined && row.after !== undefined && !sameParameterNumber(row.before, row.after));
      const before = node("td", row.before === undefined ? "—" : String(row.before)); before.hidden = !comparing;
      tr.append(name, before, node("td", row.after === undefined ? "—" : String(row.after)), node("td", `${row.min}–${row.max}`));
      return tr;
    }));
  }
  filter.addEventListener("input", render); changes.addEventListener("change", render);
  return { element: root,
    update(value: readonly ParameterTableRow[], labels?: { before: string; after: string }) {
      rows = value; if (labels) { beforeLabel = labels.before; afterLabel = labels.after; } render();
    },
    refreshLocale() { bindings.refresh(root); render(); },
  };
}
