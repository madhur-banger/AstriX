import mongoose from "mongoose";
import { config } from "./app.config";
import { logger } from "../utils/logger";

const connectDatabase = async () => {
  try {
    await mongoose.connect(config.MONGO_URI, {
      maxPoolSize: config.MONGO_MAX_POOL_SIZE,
      minPoolSize: config.MONGO_MIN_POOL_SIZE,
    });
    logger.info("Connected to Mongo Database");
  } catch (error) {
    logger.error({ err: error }, "Error connecting to Mongo Database");
    process.exit(1);
  }
};

export default connectDatabase;
