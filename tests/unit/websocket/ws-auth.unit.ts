import {authenticateHandshake, permittedChannels} from "../../../src/lib/websocket/ws-auth";
import {ADMIN, AGENT, CUSTOMER, RESTAURANT_OWNER, signAccessToken} from "../../helpers/auth";

describe("authenticateHandshake", () => {
    it("accepts a token passed in socket.io auth (native/mobile clients)", () => {
        // Arrange
        const handshake = {auth: {token: signAccessToken(CUSTOMER)}, headers: {}};

        // Act
        const user = authenticateHandshake(handshake);

        // Assert
        expect(user.userId).toBe(CUSTOMER.userId);
    });

    it("falls back to the access_token cookie (browser sessions)", () => {
        // Arrange
        const handshake = {headers: {cookie: `theme=dark; access_token=${signAccessToken(AGENT)}; lang=ar`}};

        // Act
        const user = authenticateHandshake(handshake);

        // Assert
        expect(user).toMatchObject({userId: AGENT.userId, role: "delivery_agent"});
    });

    it("rejects a handshake with no token with 401", () => {
        // Arrange
        const handshake = {headers: {cookie: "theme=dark; broken"}};

        // Act
        const act = () => authenticateHandshake(handshake);

        // Assert
        expect(act).toThrow(expect.objectContaining({statusCode: 401, message: "No token provided"}));
    });
});

describe("permittedChannels", () => {
    it("scopes each role to its own rooms", () => {
        // Arrange
        const users = [CUSTOMER, RESTAURANT_OWNER, AGENT, ADMIN];

        // Act
        const channels = users.map((u) => [...permittedChannels(u)]);

        // Assert
        expect(channels).toEqual([
            ["customer:1"],
            ["customer:100", "restaurant:10", "branch:20"],
            ["customer:300", "agent:300"],
            ["customer:900", "admin:alerts"],
        ]);
    });
});
