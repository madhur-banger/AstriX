// backend/src/models/session.model.ts
// ============================================
// SESSION MODEL - Stores Refresh Tokens
// ============================================

/**
 * WHY STORE REFRESH TOKENS IN DATABASE?
 * 
 * 1. REVOCATION: Can invalidate specific sessions (logout from one device)
 * 2. LOGOUT ALL: Can invalidate all user sessions (logout everywhere)
 * 3. SECURITY: If refresh token is compromised, can delete it
 * 4. AUDIT: Can see all active sessions for a user
 * 5. DEVICE MANAGEMENT: "Manage your devices" feature
 */

import mongoose, { Document, Schema } from "mongoose";

export interface SessionDocument extends Document {
  userId: mongoose.Types.ObjectId;
  userAgent?: string;
  ipAddress?: string;
  isValid: boolean; // Can be set to false to revoke
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const sessionSchema = new Schema<SessionDocument>(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true, // Index for fast lookup by user
    },
    userAgent: {
      type: String,
      default: null,
    },
    ipAddress: {
      type: String,
      default: null,
    },
    isValid: {
      type: Boolean,
      default: true,
      index: true, // Index for fast filtering of valid sessions
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

// Compound index for efficient queries
sessionSchema.index({ userId: 1, isValid: 1 });

const SessionModel = mongoose.model<SessionDocument>("Session", sessionSchema);

export default SessionModel;