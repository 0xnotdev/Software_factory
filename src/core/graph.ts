import type { Diagnostic, TaskContract } from "../types.js";

export interface GraphResult {
  order: string[];
  diagnostics: Diagnostic[];
}

export function analyzeGraph(tasks: TaskContract[]): GraphResult {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const diagnostics: Diagnostic[] = [];
  const state = new Map<string, "visiting" | "visited">();
  const order: string[] = [];
  const stack: string[] = [];
  const reportedCycles = new Set<string>();

  function visit(id: string): void {
    const current = state.get(id);
    if (current === "visited") return;
    if (current === "visiting") {
      const cycle = [...stack.slice(stack.indexOf(id)), id].join(" -> ");
      if (!reportedCycles.has(cycle)) {
        diagnostics.push({
          code: "DEPENDENCY_CYCLE",
          path: `.factory/tasks/${id}.yaml`,
          message: `Dependency cycle: ${cycle}`,
        });
        reportedCycles.add(cycle);
      }
      return;
    }
    const task = byId.get(id);
    if (task === undefined) return;
    state.set(id, "visiting");
    stack.push(id);
    for (const dependency of [...task.depends_on].sort()) {
      if (dependency === id) {
        diagnostics.push({
          code: "SELF_DEPENDENCY",
          path: `.factory/tasks/${id}.yaml`,
          message: `${id} cannot depend on itself`,
        });
      } else if (!byId.has(dependency)) {
        diagnostics.push({
          code: "DEPENDENCY_NOT_FOUND",
          path: `.factory/tasks/${id}.yaml`,
          message: `Unknown dependency: ${dependency}`,
        });
      } else {
        visit(dependency);
      }
    }
    stack.pop();
    state.set(id, "visited");
    order.push(id);
  }

  for (const id of [...byId.keys()].sort()) visit(id);
  return { order, diagnostics };
}
