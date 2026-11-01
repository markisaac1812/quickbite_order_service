import {CoreBranchMetadata, CoreBranchProduct, CoreCustomerAddress} from "../../src/lib/core-client/types";

// Ids shared by the stubs, the JWT users (auth.ts) and the DB factories, so a
// seeded order, the core-service view of its branch and the caller line up.
export const RESTAURANT_ID = 10;
export const OTHER_RESTAURANT_ID = 11;
export const OWNER_ID = 100;
export const BRANCH_ID = 20;
export const OTHER_BRANCH_ID = 21;
export const CUSTOMER_ID = 1;
export const ADDRESS_ID = 30;

/** Branch location — orders snapshot it; agents ping near it. */
export const BRANCH_LAT = 30.05;
export const BRANCH_LNG = 31.24;

/** core-service's view of branch 20 (GET /api/internal/branches/20). */
export function branchFixture(overrides: Partial<CoreBranchMetadata> = {}): CoreBranchMetadata {
    return {
        id: BRANCH_ID,
        restaurantId: RESTAURANT_ID,
        restaurantOwnerId: OWNER_ID,
        restaurantStatus: "active",
        region: "EG",
        isActive: true,
        acceptOrders: true,
        deliveryFee: 2000,
        commissionBps: 1000, // 10%
        currency: "EGP",
        lat: BRANCH_LAT,
        lng: BRANCH_LNG,
        name: "Downtown",
        addressText: "1 Talaat Harb St, Cairo",
        ...overrides,
    };
}

export function productsFixture(): CoreBranchProduct[] {
    return [
        {productId: 501, name: "Koshary (large)", imageUrl: null, price: 7500, stock: 10, isAvailable: true},
        {productId: 502, name: "Mint tea", imageUrl: "https://cdn.test/tea.png", price: 1000, stock: 50, isAvailable: true},
    ];
}

export function addressFixture(overrides: Partial<CoreCustomerAddress> = {}): CoreCustomerAddress {
    return {
        id: ADDRESS_ID,
        userId: CUSTOMER_ID,
        label: "Home",
        country: "Egypt",
        city: "Cairo",
        street: "Tahrir St",
        building: "12",
        apartmentNumber: "3",
        lat: 30.0444,
        lng: 31.2357,
        ...overrides,
    };
}

/** core-service's RBAC catalog per restaurant role (GET /api/internal/rbac/permissions). */
export const ROLE_PERMISSIONS: Record<string, string[]> = {
    owner: ["orders:read", "orders:cancel", "payments:read", "finance:read"],
    staff: ["orders:read"],
};
