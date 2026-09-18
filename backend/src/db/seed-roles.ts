import "dotenv/config";
import { db } from "./client";
import { roles } from "./schema";
import { RolePermissions } from "../utils/role-permission";
import { RoleType } from "../enums/role.enum";

async function seedRoles(): Promise<void> {
  for (const [name, permissions] of Object.entries(RolePermissions)) {
    await db
      .insert(roles)
      .values({ name: name as RoleType, permissions })
      .onConflictDoNothing({ target: roles.name });
  }
  const rows = await db.select().from(roles);
  console.log(`Seeded ${rows.length} roles:`, rows.map((r) => r.name));
  process.exit(0);
}

seedRoles().catch((err) => {
  console.error(err);
  process.exit(1);
});
