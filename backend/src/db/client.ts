import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
import { getEnv } from "../utils/get-env";

export const pool = new Pool({
  connectionString: getEnv("DATABASE_URL", ""),
  max: Number(getEnv("PG_MAX_POOL_SIZE", "15")),
  min: Number(getEnv("PG_MIN_POOL_SIZE", "2")),
});

export const db = drizzle(pool, { schema });
