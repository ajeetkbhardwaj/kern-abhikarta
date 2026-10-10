export interface TaskPlanStep {
  id: string;
  objective: string;
  files: string[];
  validation: string[];
  dependsOn?: string[];
  status: "pending" | "running" | "done" | "blocked";
}

export interface TaskPlan {
  objective: string;
  steps: TaskPlanStep[];
  createdAt: string;
}

export function createTaskPlan(objective: string, files: string[], validation: string[]): TaskPlan {
  return {
    objective,
    steps: [
      {
        id: "step-1",
        objective,
        files,
        validation,
        status: "pending",
      },
    ],
    createdAt: new Date().toISOString(),
  };
}

export function decomposeTask(objective: string, files: string[] = []): TaskPlanStep[] {
  return [
    {
      id: "step-1",
      objective: `Inspect and scope ${objective}`,
      files,
      validation: ["review affected files", "confirm validation target"],
      status: "pending",
    },
    {
      id: "step-2",
      objective: `Implement the fix for ${objective}`,
      files,
      validation: ["apply patch", "run relevant tests"],
      status: "pending",
    },
    {
      id: "step-3",
      objective: `Verify ${objective}`,
      files,
      validation: ["run focused checks", "summarize outcome"],
      status: "pending",
    },
  ];
}
