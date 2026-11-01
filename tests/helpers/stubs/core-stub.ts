import {Express} from "express";
import {
    CoreBranchMetadata,
    CoreBranchProduct,
    CoreCustomerAddress,
    ReserveStockItem,
} from "../../../src/lib/core-client/types";
import {addressFixture, branchFixture, productsFixture, ROLE_PERMISSIONS} from "../fixtures";
import {StubServer} from "./stub-server";

/**
 * Stand-in for core-service's internal API — only the endpoints
 * order-service calls (lib/core-client/*). Responses use core's
 * `{success, data}` envelope.
 */
export class CoreStub extends StubServer {
    branches = new Map<number, CoreBranchMetadata>();
    /** products by branch id */
    products = new Map<number, CoreBranchProduct[]>();
    addresses = new Map<number, CoreCustomerAddress>();
    /** permissions by restaurant role */
    permissions = new Map<string, string[]>();

    reset(): void {
        this.clearRecorded();
        const branch = branchFixture();
        const address = addressFixture();
        this.branches = new Map([[branch.id, branch]]);
        this.products = new Map([[branch.id, productsFixture()]]);
        this.addresses = new Map([[address.id, address]]);
        this.permissions = new Map(Object.entries(ROLE_PERMISSIONS).map(([role, perms]) => [role, [...perms]]));
    }

    protected routes(app: Express): void {
        app.get("/api/internal/branches", (req, res) => {
            const ids = String(req.query.ids ?? "").split(",").map(Number);
            const data = ids.map((id) => this.branches.get(id)).filter((b) => b !== undefined);
            res.json({success: true, data});
        });

        app.get("/api/internal/branches/:id", (req, res) => {
            const branch = this.branches.get(Number(req.params.id));
            if (!branch) return res.status(404).json({error: "BranchNotFound"});
            res.json({success: true, data: branch});
        });

        app.get("/api/internal/branches/:id/products", (req, res) => {
            const ids = new Set(String(req.query.ids ?? "").split(",").map(Number));
            const data = (this.products.get(Number(req.params.id)) ?? []).filter((p) => ids.has(p.productId));
            res.json({success: true, data});
        });

        const stockMove = (req: {body: {items?: ReserveStockItem[]}}, res: {json: (b: unknown) => void}) => {
            const items = req.body.items ?? [];
            res.json({success: true, data: {ok: true, applied: items.map((i) => ({productId: i.productId, newStock: 0}))}});
        };
        app.post("/api/internal/branches/:id/reserve-stock", stockMove);
        app.post("/api/internal/branches/:id/release-stock", stockMove);

        app.get("/api/customer/addresses/internal/:id", (req, res) => {
            const address = this.addresses.get(Number(req.params.id));
            if (!address) return res.status(404).json({error: "AddressNotFound"});
            res.json({success: true, data: address});
        });

        app.get("/api/internal/rbac/permissions", (req, res) => {
            const role = String(req.query.role);
            res.json({success: true, data: {role, permissions: this.permissions.get(role) ?? []}});
        });
    }
}
