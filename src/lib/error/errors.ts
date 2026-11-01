import {AppError} from "./AppError";

export const MalformedJsonBodyError = new AppError("Malformed JSON body", 400);
