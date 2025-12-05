import mongoose, { Document } from "mongoose";

export interface UserDocument extends Document {
    name: string;
    email: string;
    password: string;
    profilePicture: boolean;
    isActive: boolean;
    lastLogin: Date | null;
    createdAt: Date;
    updatedAt: Date;
    currentWorkspace: mongoose.Types.ObjectId | null;
    comparePassword(value: string): Promise<boolean>;
    omitPassword(): Omit<UserDocument, "password">;
}

const userSchema = new Schema<UserDocument