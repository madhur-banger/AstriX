import mongoose, { Document, Schema } from "mongoose";
import { RoleDocument } from "./roles-permission.model";

export interface MemberDocument extends Document {
  userId: mongoose.Types.ObjectId;
  workspaceId: mongoose.Types.ObjectId;
  role: RoleDocument;
  joinedAt: Date;
}

const memberSchema = new Schema<MemberDocument>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    role: {
      type: Schema.Types.ObjectId,
      ref: "Role",
      required: true,
    },
    joinedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// A user can only hold one membership per workspace. Without this, a race
// between two concurrent "join workspace" requests (check-then-insert, no
// natural atomicity) can create duplicate Member rows for the same pair.
memberSchema.index({ userId: 1, workspaceId: 1 }, { unique: true });

const MemberModel = mongoose.model<MemberDocument>("Member", memberSchema);
export default MemberModel;
