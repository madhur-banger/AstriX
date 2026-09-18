import "dotenv/config";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { users, roles, workspaces, workspaceMembers, tasks } from "../src/db/schema";
import { generateTaskCode } from "../src/utils/uuid";
import { createWorkspaceService, getWorkspaceMembersService, deleteWorkspaceService, changeMemberRoleService } from "../src/services/workspace.service";
import { createProjectService, getProjectAnalyticsService, deleteProjectService } from "../src/services/project.service";
import { createTaskService, getAllTasksService, getTaskByIdService } from "../src/services/task.service";
import { getUserByIdService } from "../src/services/user.service";

async function main() {
  console.log("--- 2.4 users: round-trip, passwordHash excluded ---");
  const [alice] = await db
    .insert(users)
    .values({ email: "alice@verify.test", name: "Alice", passwordHash: "SHOULD_NOT_LEAK" })
    .returning();
  const fetchedAlice = await getUserByIdService(alice.id);
  assert.equal(fetchedAlice.email, "alice@verify.test");
  assert.equal((fetchedAlice as Record<string, unknown>).passwordHash, undefined);
  console.log("OK - user round-trip matches, passwordHash absent from result");

  console.log("\n--- 2.5 workspaces: transaction happy path ---");
  const { workspace } = await createWorkspaceService(alice.id, { name: "Acme", description: "test ws" });
  const [ownerMembership] = await db
    .select()
    .from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, workspace.id));
  assert.ok(ownerMembership, "OWNER membership should exist after createWorkspaceService");
  const [ownerRoleCheck] = await db.select().from(roles).where(eq(roles.id, ownerMembership.roleId));
  assert.equal(ownerRoleCheck.name, "OWNER");
  console.log("OK - workspace + OWNER membership created atomically");

  console.log("\n--- 2.5 workspaces: transaction rollback proof ---");
  const beforeCount = (await db.select().from(workspaces)).length;
  try {
    await db.transaction(async (tx) => {
      await tx.insert(workspaces).values({
        name: "ShouldRollback",
        ownerId: alice.id,
        inviteCode: "ROLLBACK1",
      });
      throw new Error("deliberate failure before commit");
    });
    assert.fail("transaction should have thrown");
  } catch (err) {
    assert.equal((err as Error).message, "deliberate failure before commit");
  }
  const afterCount = (await db.select().from(workspaces)).length;
  assert.equal(afterCount, beforeCount, "workspace insert must not persist after rollback");
  console.log(`OK - workspace count unchanged after rollback (${beforeCount} before, ${afterCount} after)`);

  console.log("\n--- 2.6 tasks: leftJoin, unassigned task keeps assignee:null ---");
  const [bob] = await db.insert(users).values({ email: "bob@verify.test", name: "Bob" }).returning();
  await db.insert(workspaceMembers).values({
    userId: bob.id,
    workspaceId: workspace.id,
    roleId: ownerMembership.roleId,
  });

  const { project } = await createProjectService(alice.id, workspace.id, { name: "Launch" });

  const { task: unassignedTask } = await createTaskService(workspace.id, project.id, alice.id, {
    title: "Unassigned task",
    taskCode: generateTaskCode(),
  });
  const { task: assignedTask } = await createTaskService(workspace.id, project.id, alice.id, {
    title: "Assigned task",
    assignedTo: bob.id,
    taskCode: generateTaskCode(),
  });

  const { tasks: listedTasks, pagination } = await getAllTasksService(
    workspace.id,
    {},
    { pageSize: 10, pageNumber: 1 }
  );
  assert.equal(pagination.totalCount, 2);
  const unassignedRow = listedTasks.find((t) => t.id === unassignedTask.id);
  const assignedRow = listedTasks.find((t) => t.id === assignedTask.id);
  assert.ok(unassignedRow, "unassigned task must appear in results, not be dropped");
  assert.equal(unassignedRow!.assignee, null, "unassigned task must have assignee: null, not missing");
  assert.equal(assignedRow!.assignee!.id, bob.id);
  console.log("OK - unassigned task appears with assignee: null; assigned task's assignee is joined correctly");

  console.log("\n--- 2.6 tasks: assertAssigneeIsWorkspaceMember rejects a non-member ---");
  const [outsider] = await db.insert(users).values({ email: "outsider@verify.test", name: "Outsider" }).returning();
  try {
    await createTaskService(workspace.id, project.id, alice.id, {
      title: "Should reject",
      assignedTo: outsider.id,
      taskCode: generateTaskCode(),
    });
    assert.fail("should have thrown for non-member assignee");
  } catch (err) {
    assert.match((err as Error).message, /not a member of this workspace/);
  }
  console.log("OK - assigning a task to a non-member is rejected");

  console.log("\n--- 2.6 tasks: cross-workspace task never appears ---");
  const { workspace: otherWorkspace } = await createWorkspaceService(bob.id, { name: "Other Co" });
  const { project: otherProject } = await createProjectService(bob.id, otherWorkspace.id, { name: "Other Project" });
  await createTaskService(otherWorkspace.id, otherProject.id, bob.id, {
    title: "Other workspace task",
    taskCode: generateTaskCode(),
  });
  const { tasks: firstWorkspaceTasks } = await getAllTasksService(workspace.id, {}, { pageSize: 10, pageNumber: 1 });
  assert.equal(firstWorkspaceTasks.length, 2, "cross-workspace task must never leak into another workspace's list");
  console.log("OK - cross-workspace task does not appear");

  console.log("\n--- 2.7 project analytics: FILTER-based counts ---");
  await db.insert(tasks).values([
    { title: "Done 1", taskCode: generateTaskCode(), projectId: project.id, workspaceId: workspace.id, createdBy: alice.id, status: "DONE" },
    { title: "Overdue", taskCode: generateTaskCode(), projectId: project.id, workspaceId: workspace.id, createdBy: alice.id, status: "TODO", dueDate: new Date("2020-01-01") },
    { title: "Future, not done", taskCode: generateTaskCode(), projectId: project.id, workspaceId: workspace.id, createdBy: alice.id, status: "TODO", dueDate: new Date("2099-01-01") },
  ]);
  const { analytics } = await getProjectAnalyticsService(workspace.id, project.id);
  // 2 unassigned/assigned tasks from earlier (no due date, not DONE) + 3 just inserted = 5 total
  assert.equal(analytics.totalTasks, 5);
  assert.equal(analytics.completedTasks, 1);
  assert.equal(analytics.overdueTasks, 1);
  console.log("OK - analytics:", analytics);

  console.log("\n--- 2.8 workspace_members: 3-table join ---");
  const { members } = await getWorkspaceMembersService(workspace.id);
  assert.equal(members.length, 2);
  assert.ok(members.some((m) => m.user.id === alice.id && m.role.name === "OWNER"));
  assert.ok(members.some((m) => m.user.id === bob.id));
  console.log("OK - 3-table join returns", members.length, "members with user + role attached");

  console.log("\n--- 2.8 changeMemberRoleService: rejects changing the owner's role ---");
  const [memberRole] = await db.select().from(roles).where(eq(roles.name, "MEMBER"));
  try {
    await changeMemberRoleService(workspace.id, alice.id, memberRole.id);
    assert.fail("should reject changing the owner's role");
  } catch (err) {
    assert.match((err as Error).message, /Cannot change the role of the workspace owner/);
  }
  console.log("OK - owner role-change correctly rejected");

  console.log("\n--- 2.8 deleteProjectService: cascade deletes its tasks ---");
  await deleteProjectService(workspace.id, project.id);
  const { tasks: tasksAfterProjectDelete } = await getAllTasksService(workspace.id, {}, { pageSize: 10, pageNumber: 1 });
  assert.equal(tasksAfterProjectDelete.length, 0, "deleting a project must cascade-delete its tasks");
  console.log("OK - project delete cascaded to its tasks (0 remain)");

  console.log("\n--- 2.8 deleteWorkspaceService: cascade + currentWorkspace reassignment ---");
  const result = await deleteWorkspaceService(workspace.id, alice.id);
  const membersAfter = await db.select().from(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspace.id));
  assert.equal(membersAfter.length, 0, "deleting a workspace must cascade-delete its memberships");
  console.log("OK - deleteWorkspaceService result:", result);

  console.log("\n--- getTaskByIdService: 404 for wrong project/workspace ---");
  try {
    await getTaskByIdService(otherWorkspace.id, otherProject.id, "00000000-0000-0000-0000-000000000000");
    assert.fail("should 404 on unknown task id");
  } catch (err) {
    assert.match((err as Error).message, /Task not found/);
  }
  console.log("OK - unknown task id correctly 404s");

  console.log("\n--- cleanup ---");
  await db.delete(workspaces).where(eq(workspaces.id, otherWorkspace.id));
  await db.delete(users).where(eq(users.id, alice.id));
  await db.delete(users).where(eq(users.id, bob.id));
  await db.delete(users).where(eq(users.id, outsider.id));
  console.log("OK - verification data cleaned up");

  console.log("\nAll Phase 2 verifications passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error("\nVERIFICATION FAILED:", err);
  process.exit(1);
});
