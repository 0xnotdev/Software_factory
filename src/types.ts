export interface Diagnostic {
  code: string;
  path: string;
  message: string;
}

export interface ProjectContract {
  schema_version: 1;
  id: string;
  name: string;
  intent: string;
  audience: string;
  goals: string[];
  non_goals: string[];
  constraints: string[];
  documents: { required: string[] };
  completion: string;
}

export interface CompletionCondition {
  id: string;
  outcome: string;
  method: "executable" | "observation";
  check_id?: string;
  protocol?: string;
  evidence: string;
}

export interface CompletionContract {
  schema_version: 1;
  project: string;
  conditions: CompletionCondition[];
}

export interface TaskContract {
  schema_version: 1;
  id: string;
  title: string;
  outcome: string;
  kind?: "ship" | "enabling";
  depends_on: string[];
  complexity: "bounded" | "normal" | "critical";
  risk: "bounded" | "normal" | "critical";
  acceptance: Array<{ id: string; statement: string }>;
  advances: string[];
  context: { topics: string[]; required: string[] };
  evidence: { required: string[] };
  delivery?: string;
}
