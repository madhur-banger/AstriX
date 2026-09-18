/**
 * INTEGRATION TESTS: services/account.service.ts
 * -------------------------------------------------
 * Real Postgres (testcontainers, see tests/setup/global-setup.ts) via
 * the real Drizzle client (src/db/client.ts) - no mocks.
 */
import { describe, it, expect } from "vitest";
import {
  findAccountByProviderService,
  createAccountService,
} from "../../src/services/account.service";
import { createTestUser } from "../setup/fixtures";

describe("account.service (integration - real Postgres via testcontainers)", () => {
  it("findAccountByProviderService returns null for no match", async () => {
    const result = await findAccountByProviderService("GOOGLE", "no-such-provider-id");
    expect(result).toBeNull();
  });

  it("findAccountByProviderService matches on the (provider, providerId) composite, not providerId alone", async () => {
    const user = await createTestUser();
    const sharedProviderId = "shared-id-123";
    await createAccountService({ userId: user.id, provider: "GOOGLE", providerId: sharedProviderId });
    await createAccountService({ userId: user.id, provider: "GITHUB", providerId: sharedProviderId });

    const googleAccount = await findAccountByProviderService("GOOGLE", sharedProviderId);
    const githubAccount = await findAccountByProviderService("GITHUB", sharedProviderId);

    expect(googleAccount?.provider).toBe("GOOGLE");
    expect(githubAccount?.provider).toBe("GITHUB");
    expect(googleAccount?.id).not.toBe(githubAccount?.id);
  });

  it("createAccountService persists and returns the row", async () => {
    const user = await createTestUser();

    const account = await createAccountService({ userId: user.id, provider: "EMAIL", providerId: user.email });

    expect(account.userId).toBe(user.id);
    expect(account.provider).toBe("EMAIL");
    expect(account.providerId).toBe(user.email);

    const refetched = await findAccountByProviderService("EMAIL", user.email);
    expect(refetched?.id).toBe(account.id);
  });
});
