import type {Request, Response, NextFunction} from "express";
import {logger} from "../logger/logger";
import {AppError} from "./AppError";
import {MalformedJsonBodyError} from "./errors";
import {HttpClientError} from "./types";

/**
 * Normalises anything thrown into an AppError. Express' body parser raises
 * http-errors with a 4xx `status` and `expose: true` (malformed JSON,
 * oversized payload) before any controller runs. Those are the client's
 * fault, not a crash, so they keep their status instead of becoming a 500.
 */
function toAppError(err: Error): AppError {
    if (err instanceof AppError) return err;
    const httpErr = err as Error & HttpClientError;
    if (httpErr?.type === "entity.parse.failed") return MalformedJsonBodyError;
    if (httpErr?.expose && httpErr.status && httpErr.status >= 400 && httpErr.status < 500) {
        return new AppError(httpErr.message, httpErr.status);
    }
    return new AppError(err?.message ?? "Unknown error", 500, false);
}

export function errorHandler(
    err: Error,
    req: Request,
    res: Response,
    _next: NextFunction,
) {
    const appErr = toAppError(err);
    const operational = appErr.isOperational;

    logger.error(appErr.message, {
        statusCode: appErr.statusCode,
        stack: appErr.stack,
        operational,
        path: req.originalUrl,
        method: req.method,
        correlationId: req.correlationId,
    });

    if (operational) {
        return res.status(appErr.statusCode).json({error: appErr.message});
    }
    return res.status(500).json({error: "Something went wrong"});
}
