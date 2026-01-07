import passport from "passport"
import { Request } from "express"
import { Strategy as GoogleStrategy } from "passport-google-oauth20"
import { Strategy as localStrategy } from "passport-local"

import {
    Strategy as JwtStrategy,
    ExtractJwt,
    StrategyOptions
} from "passport-jwt"
import { config } from "./app.config"
import { NotFoundException } from "../utils/appError"
import { ProviderEnum } from "../enums/account-provider.enum"
import { findUserByIdService, loginOrCreateAccountService, verifyUserService } from "../services/auth.service"
import { signJwtToken } from "../utils/jwt"


passport.use( 
    new GoogleStrategy(
        {
            clientID: config.GOOGLE_CLIENT_ID,
            clientSecret: config.GOOGLE_CLIENT_SECRET,
            callbackURL: config.GOOGLE_CALLBACK_URL,
            scope: ["profile", "email"],
            passReqToCallback: true,
        },
        async(req: Request, accesToken, refreshToken, profile, done) => {
            try {
                const { email, sub: googleId, picture} = profile._json;
                console.log(profile, "profile");
                console.log(googleId, "googleId");
                if(!googleId){
                    throw new  NotFoundException("Google ID (sub) is missing")
                }

                const {user} = await loginOrCreateAccountService({
                    provider: ProviderEnum.GOOGLE,
                    displayName: profile.displayName,
                    providerId: googleId,
                    email: email,
                });

                const token = signJwtToken({userId: user._id});
 
                done(null, user, {
                    token
                });
            } catch (error) {
                done(error, false);
            }
        }
    )
);

passport.use(
    new localStrategy(
        {
            usernameField: "email",
            passwordField: "password",
            session: false,
        },
        async (email, password, done) => {
            try {
                const user = await verifyUserService({email, password});
                return done(null, user);
            } catch (error: any) {
                return done(error, false, {message: error?.message })
            }
        }
    )
);

interface JwtPaylaod {
    userId: string;
}   

const options: StrategyOptions = {
    jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
    secretOrKey: config.JWT_SECRET,
    audience: ["user"],
    algorithms: ["HS256"]
};

passport.use(
    new JwtStrategy(options, async (payload: JwtPaylaod, done) => {
        try {
            const user = await findUserByIdService(payload.userId);
            if(!user){
                return done(null, false)
            }
            return done(null, user);
        } catch (error) {
            return done(error, false);
        }
    })
)


export const passportAuthenticateJWT = passport.authenticate("jwt",{
    session: false,
});