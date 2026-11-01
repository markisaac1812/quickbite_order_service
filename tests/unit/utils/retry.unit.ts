import {retry} from "../../../src/pkg/utils/retry";

const FAST = {initialDelayMs: 1, maxDelayMs: 2};

/** A real async operation that fails `failures` times before succeeding. */
function flaky(failures: number, error: Error = new Error("transient")) {
    let calls = 0;
    const fn = async () => {
        calls += 1;
        if (calls <= failures) throw error;
        return "ok";
    };
    return {fn, calls: () => calls};
}

describe("retry", () => {
    it("returns the first successful result without retrying", async () => {
        // Arrange
        const op = flaky(0);

        // Act
        const result = await retry(op.fn, {attempts: 3, ...FAST});

        // Assert
        expect(result).toBe("ok");
        expect(op.calls()).toBe(1);
    });

    it("retries transient failures until the operation succeeds", async () => {
        // Arrange
        const op = flaky(2);

        // Act
        const result = await retry(op.fn, {attempts: 3, ...FAST});

        // Assert
        expect(result).toBe("ok");
        expect(op.calls()).toBe(3);
    });

    it("gives up after the configured attempts and rethrows the last error", async () => {
        // Arrange
        const op = flaky(5, new Error("still down"));

        // Act
        const act = retry(op.fn, {attempts: 3, ...FAST});

        // Assert
        await expect(act).rejects.toThrow("still down");
        expect(op.calls()).toBe(3);
    });

    it("stops immediately on an error the caller marks as non-retryable", async () => {
        // Arrange
        const op = flaky(5, new Error("400 bad request"));
        const isRetryable = (err: unknown) => !(err as Error).message.startsWith("400");

        // Act
        const act = retry(op.fn, {attempts: 3, ...FAST, isRetryable});

        // Assert
        await expect(act).rejects.toThrow("400 bad request");
        expect(op.calls()).toBe(1);
    });
});
