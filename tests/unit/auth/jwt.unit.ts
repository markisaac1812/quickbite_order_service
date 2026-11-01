import jwt from "jsonwebtoken";
import {verifyAccessToken, verifyRefreshToken} from "../../../src/lib/auth/jwt";
import {env} from "../../../src/lib/config/env";
import {RESTAURANT_OWNER, signAccessToken} from "../../helpers/auth";

describe("verifyAccessToken", () => {
    it("returns the core-service claims of a valid token", () => {
        // Arrange
        const token = signAccessToken(RESTAURANT_OWNER);

        // Act
        const claims = verifyAccessToken(token);

        // Assert
        expect(claims).toEqual(RESTAURANT_OWNER);
    });

    it("rejects an expired token with 401", () => {
        // Arrange
        const token = signAccessToken(RESTAURANT_OWNER, -10);

        // Act
        const act = () => verifyAccessToken(token);

        // Assert
        expect(act).toThrow(expect.objectContaining({statusCode: 401, message: "User not authenticated"}));
    });

    it("rejects a token signed with another secret", () => {
        // Arrange
        const token = jwt.sign(RESTAURANT_OWNER, "not-our-secret");

        // Act
        const act = () => verifyAccessToken(token);

        // Assert
        expect(act).toThrow(expect.objectContaining({statusCode: 401}));
    });
});

describe("verifyRefreshToken", () => {
    it("accepts tokens signed with the refresh secret only", () => {
        // Arrange
        const refresh = jwt.sign(RESTAURANT_OWNER, env.jwt.refreshSecret);
        const access = signAccessToken(RESTAURANT_OWNER);

        // Act
        const claims = verifyRefreshToken(refresh);
        const act = () => verifyRefreshToken(access);

        // Assert
        expect(claims.userId).toBe(RESTAURANT_OWNER.userId);
        expect(act).toThrow(expect.objectContaining({statusCode: 401}));
    });
});
