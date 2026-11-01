import {archiveCutoff, archivedPortionOf} from "../../../src/lib/knex/knex";

describe("archiveCutoff", () => {
    it("is midnight UTC on Jan 1 of the current UTC year", () => {
        // Arrange
        const now = new Date("2026-11-01T10:15:00.000Z");

        // Act
        const cutoff = archiveCutoff(now);

        // Assert
        expect(cutoff.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    });

    it("follows the UTC year, not the caller's local year, around New Year", () => {
        // Arrange — still Dec 31 in New York, already Jan 1 in UTC
        const now = new Date("2026-12-31T23:30:00.000-05:00");

        // Act
        const cutoff = archiveCutoff(now);

        // Assert
        expect(cutoff.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    });
});

describe("archivedPortionOf", () => {
    const cutoff = new Date("2026-01-01T00:00:00.000Z");

    it("keeps unbounded reads on the hot cluster only", () => {
        // Arrange
        const from = undefined;
        const to = new Date("2026-06-01T00:00:00.000Z");

        // Act
        const slice = archivedPortionOf(from, to, cutoff);

        // Assert
        expect(slice).toBeNull();
    });

    it("returns null when the range starts exactly at the cutoff", () => {
        // Arrange
        const from = new Date(cutoff);

        // Act
        const slice = archivedPortionOf(from, undefined, cutoff);

        // Assert
        expect(slice).toBeNull();
    });

    it("clamps the archive slice to the cutoff when the range straddles New Year", () => {
        // Arrange
        const from = new Date("2025-11-01T00:00:00.000Z");
        const to = new Date("2026-03-01T00:00:00.000Z");

        // Act
        const slice = archivedPortionOf(from, to, cutoff);

        // Assert
        expect(slice).toEqual({cluster: "archive", from, to: cutoff});
    });

    it("keeps the requested end when the whole range is in a prior year", () => {
        // Arrange
        const from = new Date("2025-03-01T00:00:00.000Z");
        const to = new Date("2025-06-01T00:00:00.000Z");

        // Act
        const slice = archivedPortionOf(from, to, cutoff);

        // Assert
        expect(slice).toEqual({cluster: "archive", from, to});
    });
});
