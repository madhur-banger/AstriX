import { UserDocument } from "../models/user.model";

declare global {
    namespace Express {
        interface User extends UserDocument {
            _id?: any;
        }
        interface authInfo {
            token?: string;
        }
    }
}  

declare module 'swagger-ui-express'

declare module 'swagger-jsdoc'