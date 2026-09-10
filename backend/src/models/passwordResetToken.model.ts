import mongoose, { Document, Schema } from "mongoose";

/**
 * Stores a HASH of the reset token, never the raw value - the raw token
 * only ever exists in the email link and in memory during the request that
 * issued it. If this collection leaked, the hashes alone aren't usable to
 * reset anyone's password.
 */
export interface PasswordResetTokenDocument extends Document {
  userId: mongoose.Types.ObjectId;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
}

const passwordResetTokenSchema = new Schema<PasswordResetTokenDocument>(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    tokenHash: {
      type: String,
      required: true,
      unique: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: { expireAfterSeconds: 0 }, // TTL index - MongoDB auto-deletes expired docs
    },
  },
  {
    timestamps: true,
  }
);

const PasswordResetTokenModel = mongoose.model<PasswordResetTokenDocument>(
  "PasswordResetToken",
  passwordResetTokenSchema
);

export default PasswordResetTokenModel;
