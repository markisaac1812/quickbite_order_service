import "../setup-env"; // first: env.ts must see .env.test
import {destroyAll} from "../../src/lib/knex/knex";

/** Closes the shard pools globalSetup opened in Jest's parent process. */
export default async function globalTeardown(): Promise<void> {
    await destroyAll();
}
