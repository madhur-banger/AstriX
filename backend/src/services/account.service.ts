import { eq, and } from "drizzle-orm";
import { db } from "../db/client";
import { accounts } from "../db/schema";

export const findAccountByProviderService = async (
  provider: "GOOGLE" | "GITHUB" | "FACEBOOK" | "EMAIL",
  providerId: string
) => {
  const [account] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.provider, provider), eq(accounts.providerId, providerId)));

  return account ?? null;
};

export const createAccountService = async (data: {
  userId: string;
  provider: "GOOGLE" | "GITHUB" | "FACEBOOK" | "EMAIL";
  providerId: string;
  refreshToken?: string;
}) => {
  const [account] = await db.insert(accounts).values(data).returning();
  return account;
};
