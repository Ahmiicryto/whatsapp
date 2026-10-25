export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new HttpError(400, msg, details);
export const unauthorized = (msg = "Not signed in") => new HttpError(401, msg);
export const forbidden = (msg = "You don't have access to this") => new HttpError(403, msg);
export const notFound = (msg = "Not found") => new HttpError(404, msg);

/** Job errors that must not be retried (bad number, missing template, ...). */
export class PermanentError extends Error {
  constructor(message) {
    super(message);
    this.permanent = true;
  }
}

/** Thrown by a job handler to run it again later without counting an attempt. */
export class Reschedule extends Error {
  constructor(runAt, reason = "rescheduled") {
    super(reason);
    this.runAt = runAt;
  }
}

/** Wraps async express handlers so thrown errors reach the error middleware. */
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
