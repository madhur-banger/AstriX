import "dotenv/config";
import express, {NextFunction, Request, Response} from "express";
import cors from "cors";
import session from "cookie-session";
import { config } from "./config/app.config";
import connectDatabase from "./config/database.config";
import { errorHandler } from "./middlewares/errorHandles.middleware";
import { BadRequestException } from "./utils/appError";
import { ErrorCodeEnum } from "./enums/error-code.enums";


const app = express();
const BASE_PATH = config.BASE_PATH;

app.use(express.json());

app.use(express.urlencoded({extended: true}));

app.use(session({
    name: "session",
    keys: [config.SESSION_SECRET],
    maxAge: 24 * 60 * 60 * 1000,
    secure: config.NODE_ENV === "production",
    httpOnly: true,
    sameSite: "lax",
})
);



app.use(
    cors({
        origin: config.FRONTEND_ORIGIN,
        credentials: true,
    })
);


app.get('/', (req: Request, res: Response, next: NextFunction) => {
    throw new BadRequestException(
        "This is bad Request",
        ErrorCodeEnum.AUTH_INVALID_TOKEN
    );
});



app.use(errorHandler);

app.listen(config.PORT, async() => {
    console.log(`Server listening on port ${config.PORT} in  ${config.NODE_ENV} Enviornment`);
    await connectDatabase();
});