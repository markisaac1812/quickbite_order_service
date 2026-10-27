import {AppError} from "../error/AppError";

export function archiveSchemaMismatchError(table: string, missingColumns: string[]) {
    return new AppError(
        `ArchiveSchemaMismatch: ${table} is missing [${missingColumns.join(", ")}] on the archive cluster — run migrations with CLUSTER=archive`,
        500,
    );
}

export function archiveCopyVerificationError(table: string, expected: number, found: number) {
    return new AppError(
        `ArchiveCopyVerificationFailed: ${table} expected ${expected} rows on archive, found ${found}`,
        500,
    );
}
