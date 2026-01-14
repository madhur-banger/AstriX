export const ProviderEnum = {
  GOOGLE: "GOOGLE",
  GITHUB: "GITHUB",
  FACEBOOK: "FACEBOOK",
  EMAIL: "EMAIL",
} as const;

export type ProviderEnumType = keyof typeof ProviderEnum;
