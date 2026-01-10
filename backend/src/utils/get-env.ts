export const getEnv = <T extends string>(
  key: string,
  defaultValue?: T
): T => {
  const value = process.env[key];

  if (value === undefined) {
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new Error(`Environment variable ${key} is not set`);
  }

  return value as T;
};
