import {fromMinor, multiplyMinor, sumMinor, toMinor} from "../../../src/pkg/utils/money";
import {toMs, toSeconds} from "../../../src/pkg/utils/time";

describe("money (integer minor units)", () => {
    it("converts major to minor units, rounding away float noise", () => {
        // Arrange
        const amounts = [18.4, 0.1 + 0.2, 19.99];

        // Act
        const minor = amounts.map(toMinor);

        // Assert
        expect(minor).toEqual([1840, 30, 1999]);
    });

    it("converts minor units back to major units", () => {
        // Arrange
        const minor = 18050;

        // Act
        const major = fromMinor(minor);

        // Assert
        expect(major).toBe(180.5);
    });

    it("sums line totals and multiplies a unit price by quantity exactly", () => {
        // Arrange
        const lines = [multiplyMinor(7500, 2), multiplyMinor(1000, 3)];

        // Act
        const subtotal = sumMinor(lines);

        // Assert
        expect(lines).toEqual([15000, 3000]);
        expect(subtotal).toBe(18000);
        expect(sumMinor([])).toBe(0);
    });
});

describe("time", () => {
    it("converts durations to milliseconds and seconds", () => {
        // Arrange
        const day = {value: 1, unit: "d" as const};

        // Act
        const ms = toMs(day.value, day.unit);
        const sec = toSeconds(15, "m");

        // Assert
        expect(ms).toBe(86_400_000);
        expect(sec).toBe(900);
    });
});
