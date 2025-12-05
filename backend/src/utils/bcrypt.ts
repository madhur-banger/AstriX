import bcrypt from "bcrypt";

export const hashValue = async(value: string, saltRound: number = 10) =>
    await bcrypt.hash(value,saltRound);


export const compareValue = async(value: string, hashedValue: string) => 
    await bcrypt.compare(value, hashedValue);