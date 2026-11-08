import type { AgentPlan } from "../../agent/actions.js";
import { actionDiffGroups } from "../action-diff.js";
import { formatUiMessage } from "../i18n/ui-message.js";

/** Ordered proposed actions shared by chat history and command approval. */
export function createActionDetails() {
  const element = document.createElement("ol"); element.className = "timeline-action-list";
  let snapshot = "";

  function render(plan: AgentPlan) {
    const next = JSON.stringify([plan, document.documentElement.lang]);
    if (snapshot === next) return;
    const labels = actionDiffGroups(plan.actions, plan.targets, "summary").flatMap((group) => group.rows);
    for (const [index, action] of plan.actions.entries()) {
      let row = element.children[index] as HTMLLIElement | undefined;
      if (!row) {
        row = document.createElement("li");
        const details = document.createElement("details"); details.className = "timeline-activity-input";
        details.dataset.actionIndex = String(index);
        const summary = document.createElement("summary"); summary.className = "timeline-activity-detail-label";
        const body = document.createElement("div"); body.className = "detail-scroll-region";
        body.tabIndex = 0; body.setAttribute("role", "region");
        const parameters = document.createElement("pre"); parameters.className = "timeline-activity-detail-content";
        const target = document.createElement("pre"); target.className = "timeline-activity-detail-content";
        body.append(parameters, target); details.append(summary, body); row.append(details); element.append(row);
      }
      const details = row.firstElementChild as HTMLDetailsElement;
      const label = window.LiveSmithI18n?.format(labels[index]!) ?? formatUiMessage(labels[index]!);
      details.firstElementChild!.textContent = label;
      const body = details.lastElementChild as HTMLElement;
      body.setAttribute("aria-label", `${window.LiveSmithI18n?.t("Input parameters") ?? "Input parameters"} · ${index + 1}`);
      const parameters = JSON.stringify(action, null, 2);
      if (body.firstElementChild!.textContent !== parameters) body.firstElementChild!.textContent = parameters;
      const target = "trackRef" in action && action.trackRef && plan.targets?.[action.trackRef];
      const binding = target ? JSON.stringify({ targets: { [action.trackRef!]: target } }, null, 2) : "";
      if (body.lastElementChild!.textContent !== binding) body.lastElementChild!.textContent = binding;
      (body.lastElementChild as HTMLElement).hidden = !target;
    }
    while (element.children.length > plan.actions.length) element.lastElementChild!.remove();
    snapshot = next;
  }

  return { element, render };
}
