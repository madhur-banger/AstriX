import { Types } from "mongoose";
import { Logger } from "pino";
import { SessionDocument } from "../models/session.model";
import { UserDocument } from "../models/user.model";

declare global {
  namespace Express {
    interface User extends UserDocument {
      // Mongoose assigns _id at document construction time, so it is
      // always present on anything that came out of (or is on its way
      // into) the database. Typing it as an optional `any` forced
      // defensive `?.` chains at every call site for a value that can
      // never actually be missing.
      _id: Types.ObjectId;
    }
    interface authInfo {
      token?: string;
    }
    interface Request {
      user?: User;
      session?: SessionDocument;
      // Attached by pino-http (see index.ts) - a per-request child
      // logger carrying this request's correlation id. Optional
      // because app assemblies that don't mount pino-http (some test
      // harnesses) won't have it.
      log?: Logger;
    }
  }
}

declare module "swagger-ui-express";

declare module "swagger-jsdoc";
