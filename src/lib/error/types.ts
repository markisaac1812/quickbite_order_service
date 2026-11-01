/**
 * Shape of the errors Express' body parser (and any other `http-errors`
 * producer) raises before our handlers run — malformed JSON, payload too
 * large, unsupported charset. `expose: true` marks the message as safe to
 * show the client.
 */
export interface HttpClientError {
    message: string;
    status?: number;
    expose?: boolean;
    type?: string;
}
