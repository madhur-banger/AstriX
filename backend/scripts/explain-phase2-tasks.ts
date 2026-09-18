import "dotenv/config";
import { sql, eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { users, workspaces, tasks } from "../src/db/schema";
import { generateTaskCode } from "../src/utils/uuid";
import { createWorkspaceService } from "../src/services/workspace.service";
import { createProjectService } from "../src/services/project.service";

async function main() {
  const [owner] = await db.insert(users).values({ email: "explain-owner@verify.test", name: "Owner" }).returning();
  const workspace = await createWorkspaceService(owner.id, { name: "Explain Bench" });
  const { project } = await createProjectService(owner.id, workspace.id, { name: "Bench Project" });

  const rows = Array.from({ length: 500 }, (_, i) => ({
    title: `Bench task ${i}`,
    taskCode: generateTaskCode(),
    projectId: project.id,
    workspaceId: workspace.id,
    createdBy: owner.id,
    status: i % 5 === 0 ? ("DONE" as const) : ("TODO" as const),
  }));
  await db.insert(tasks).values(rows);
  console.log(`Seeded ${rows.length} tasks in workspace ${workspace.id}`);

  const plan = await db.execute(sql`
    EXPLAIN ANALYZE
    SELECT * FROM tasks WHERE workspace_id = ${workspace.id} AND status = 'TODO'
  `);
  console.log("\n--- EXPLAIN ANALYZE: getAllTasksService's workspace+status filter ---");
  for (const row of plan.rows as Array<Record<string, unknown>>) {
    console.log(Object.values(row)[0]);
  }

  await db.delete(workspaces).where(eq(workspaces.id, workspace.id));
  await db.delete(users).where(eq(users.id, owner.id));
  console.log("\nCleaned up bench data.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
