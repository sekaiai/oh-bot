let bearer: string | null = null;
export const getBearerToken = (): string | null => bearer;
export const setBearerToken = (value: string | null): void => { bearer = value; };
