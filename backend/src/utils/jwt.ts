import { config } from "../config/app.config";
import { UserDocument } from "../models/user.model"
import jwt, {SignOptions} from "jsonwebtoken"

export type AccessTPayload = {
    userId: UserDocument["_id"];
};

type SignOptsAndSecret = SignOptions & {
    secret: string; 
};

const defaults: SignOptions = {
    audience: ["user"],
};

export const accessTokenSignOptions: SignOptsAndSecret = {
    expiresIn: config.JWT_EXPIRES_IN,
    secret: config.JWT_SECRET
};


export const signJwtToken = (
    payload: AccessTPayload,
    options?: SignOptsAndSecret
) => {
    const {secret, ...opts } = options || accessTokenSignOptions;
    return jwt.sign(payload, secret, {
        ...defaults,
        ...opts
    });
}