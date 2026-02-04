import "dotenv/config";
import mongoose from "mongoose";
import connectDatabase from "../config/database.config";
import RoleModel from "../models/roles-permission.model";
import { RolePermissions } from "../utils/role-permission";

const seedRoles = async () => {
  console.log("Seeding roles started...");

  await connectDatabase();

  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    console.log("Clearing existing roles...");
    await RoleModel.deleteMany({}, { session });

    for (const roleName in RolePermissions) {
      const role = roleName as keyof typeof RolePermissions;
      const permissions = RolePermissions[role];

      // Check if the role already exists
      const existingRole = await RoleModel.findOne({ name: role }).session(
        session
      );
      if (!existingRole) {
        const newRole = new RoleModel({
          name: role,
          permissions: permissions,
        });
        await newRole.save({ session });
        console.log(`Role ${role} added with permissions.`);
      } else {
        console.log(`Role ${role} already exists.`);
      }
    }

    await session.commitTransaction();
    console.log("Transaction committed.");
    console.log("Seeding completed successfully.");
  } catch (error) {
    // Without this the transaction stayed open on failure, holding locks
    // until the server timed it out. Same try/catch/finally shape as the
    // transactional services (see auth.service.ts / workspace.service.ts).
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

// This is a one-shot script, not a server: it has to close its own Mongo
// connection and exit, otherwise the open connection keeps the event loop
// alive and `npm run seed` hangs forever instead of returning to the shell.
const shutdown = async (exitCode: number) => {
  try {
    await mongoose.disconnect();
  } catch (error) {
    console.error("Error disconnecting from Mongo:", error);
  }
  process.exit(exitCode);
};

seedRoles()
  .then(() => shutdown(0))
  .catch((error) => {
    console.error("Error running seed script:", error);
    return shutdown(1);
  });
