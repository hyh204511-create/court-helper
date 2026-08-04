export type ErrorDetails = unknown[];

export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly retryable: boolean;
  public readonly details: ErrorDetails;

  constructor(
    message: string,
    code: string,
    statusCode: number,
    retryable = false,
    details: ErrorDetails = [],
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(details: ErrorDetails = []) {
    super('Validation failed', 'VALIDATION_ERROR', 400, false, details);
  }
}

export class AuthenticationRequiredError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 'AUTH_REQUIRED', 401, false);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, 'FORBIDDEN', 403, false);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(message, 'NOT_FOUND', 404, false);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict', code = 'CONFLICT') {
    super(message, code, 409, false);
  }
}

export class DependencyUnavailableError extends AppError {
  constructor(message = 'Dependency unavailable') {
    super(message, 'DEPENDENCY_UNAVAILABLE', 503, true);
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = 'Payload too large') {
    super(message, 'PAYLOAD_TOO_LARGE', 413, false);
  }
}

export function errorFromFastify(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  const candidate = error as {
    statusCode?: number;
    validation?: Array<{ instancePath?: string; keyword?: string }>;
  };
  if (Array.isArray(candidate?.validation)) {
    return new ValidationError(candidate.validation.map((item) => ({
      field: item.instancePath?.replace(/^\//, '') || 'request',
      code: item.keyword || 'invalid',
    })));
  }
  if (candidate?.statusCode === 404) {
    return new NotFoundError();
  }
  if (candidate?.statusCode === 413) {
    return new AppError('Payload too large', 'PAYLOAD_TOO_LARGE', 413, false);
  }
  if (candidate?.statusCode === 400) {
    return new ValidationError();
  }
  return new AppError('Internal server error', 'INTERNAL_ERROR', 500, true);
}

export function errorEnvelope(error: AppError, requestId: string) {
  return {
    error: {
      code: error.code,
      message: error.message,
      requestId,
      retryable: error.retryable,
      details: error.details,
    },
  };
}
