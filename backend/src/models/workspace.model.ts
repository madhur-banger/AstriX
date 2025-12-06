import mongoose, { Document, Schema } from "mongoose";
import { generateInviteCode } from "../utils/uuid";


export interface WorkspaceDocument extends Document {
    name: string;
    description: string;
    owner: mongoose.Types.ObjectId;
    inviteCode: string;
    createdAt: Date;
    updatedAt: Date;
}

const WorkspaceSchema = new Schema<WorkspaceDocument>(
    {
        name: {
            type: String,
            required: true,
            trim: true
        },
        description: {
            type: String,
            required: false,
        },
        owner: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },
        inviteCode: {
            type: String,
            required: true,
            unique: true,
            default: generateInviteCode,
        },
    },
    {
        timestamps: true,
    }
);

WorkspaceSchema.methods.resetInviteCode = function () {
    this.inviteCode = generateInviteCode();
}

const WorkspaceModel = mongoose.model<WorkspaceDocument>(
    "Workspace",
    WorkspaceSchema
);

export default WorkspaceModel;