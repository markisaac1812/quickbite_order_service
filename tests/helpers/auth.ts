import jwt from "jsonwebtoken";
import {env} from "../../src/lib/config/env";
import {JWTPayload} from "../../src/lib/auth/jwt";
import {BRANCH_ID, CUSTOMER_ID, OTHER_BRANCH_ID, OTHER_RESTAURANT_ID, OWNER_ID, RESTAURANT_ID} from "./fixtures";

// Same ids the factories and stubs default to, so a seeded order "belongs" to these users.
export const CUSTOMER: JWTPayload = {userId: CUSTOMER_ID, role: "customer", email: "customer@test.com"};
export const OTHER_CUSTOMER: JWTPayload = {userId: 2, role: "customer", email: "other@test.com"};
export const RESTAURANT_OWNER: JWTPayload = {
    userId: OWNER_ID,
    role: "restaurant_user",
    email: "owner@test.com",
    restaurantId: RESTAURANT_ID,
    restaurantRole: "owner",
    branchIds: [BRANCH_ID],
};
/** Staff assigned to branch 20 — `staff` role only has orders:read. */
export const BRANCH_STAFF: JWTPayload = {
    userId: 101,
    role: "restaurant_user",
    email: "staff@test.com",
    restaurantId: RESTAURANT_ID,
    restaurantRole: "staff",
    branchIds: [BRANCH_ID],
};
/** Staff of the same restaurant, but assigned to a different branch. */
export const OTHER_BRANCH_STAFF: JWTPayload = {...BRANCH_STAFF, userId: 102, email: "staff2@test.com", branchIds: [OTHER_BRANCH_ID]};
export const OTHER_RESTAURANT_OWNER: JWTPayload = {
    userId: 200,
    role: "restaurant_user",
    email: "owner2@test.com",
    restaurantId: OTHER_RESTAURANT_ID,
    restaurantRole: "owner",
    branchIds: [40],
};
export const AGENT: JWTPayload = {userId: 300, role: "delivery_agent", email: "agent@test.com"};
export const OTHER_AGENT: JWTPayload = {userId: 301, role: "delivery_agent", email: "agent2@test.com"};
export const ADMIN: JWTPayload = {userId: 900, role: "system_admin", email: "admin@test.com"};

/** Access token signed exactly like core-service signs it (same secret, same claims). */
export function signAccessToken(user: JWTPayload, expiresInSec = Number(env.jwt.accessExpiresIn)): string {
    return jwt.sign(user, env.jwt.accessSecret, {expiresIn: expiresInSec});
}

/** `Cookie` header value — the guard reads the token from the `access_token` cookie. */
export function authCookie(user: JWTPayload): string {
    return `access_token=${signAccessToken(user)}`;
}
