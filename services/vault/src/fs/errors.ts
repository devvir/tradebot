export class NotFoundError extends Error {}

/** A file cannot be created because one already exists at its path. */
export class AlreadyExistsError extends Error {}

/** An uploaded file is empty or not a complete gzip stream. */
export class InvalidUploadError extends Error {}
