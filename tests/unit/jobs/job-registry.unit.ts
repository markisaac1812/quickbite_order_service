import {listJobs, register} from "../../../src/lib/jobs/job-registry";
import {startAll, stopAll} from "../../../src/lib/jobs/scheduler";
import {waitFor} from "../../helpers/wait";

afterEach(async () => {
    await stopAll();
});

describe("job registry", () => {
    it("lists registered jobs in registration order", () => {
        // Arrange
        const job = {name: "registry:a", cron: "0 3 * * *", handler: () => {}};

        // Act
        register(job);

        // Assert
        expect(listJobs().map((j) => j.name)).toEqual(["registry:a"]);
    });

    it("refuses a duplicate job name", () => {
        // Arrange
        const duplicate = {name: "registry:a", cron: "0 4 * * *", handler: () => {}};

        // Act
        const act = () => register(duplicate);

        // Assert
        expect(act).toThrow("duplicate scheduled job: registry:a");
    });
});

describe("scheduler", () => {
    it("runs a job on every tick and keeps ticking after the handler throws", async () => {
        // Arrange
        let ticks = 0;
        register({
            name: "scheduler:every-second",
            cron: "* * * * * *",
            handler: async () => {
                ticks += 1;
                throw new Error("boom");
            },
        });

        // Act
        startAll();

        // Assert
        await waitFor(() => ticks >= 2, {timeoutMs: 4000});
        expect(ticks).toBeGreaterThanOrEqual(2);
    });

    it("refuses to start when a job has an invalid cron expression", () => {
        // Arrange
        register({name: "scheduler:broken", cron: "every tuesday", handler: () => {}});

        // Act
        const act = () => startAll();

        // Assert
        expect(act).toThrow("invalid cron expression for job scheduler:broken: every tuesday");
    });
});
