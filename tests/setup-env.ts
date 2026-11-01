import {config} from "dotenv";
import path from "path";

// Must run before anything imports src/lib/config/env.ts. dotenv never
// overrides a key that is already set, so .env.test wins over .env.
config({path: path.resolve(__dirname, "../.env.test"), quiet: true});
