import { ErrorCode } from '@facebook-automation/shared-types';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly errorCode: ErrorCode;
  public readonly requiresRelogin: boolean;

  constructor(
    message: string,
    errorCode: ErrorCode,
    statusCode: number = 500,
    requiresRelogin: boolean = false,
  ) {
    super(message);
    this.name = this.constructor.name;
    this.errorCode = errorCode;
    this.statusCode = statusCode;
    this.requiresRelogin = requiresRelogin;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class SessionExpiredError extends AppError {
  constructor(message = 'Session has expired') {
    super(message, ErrorCode.SESSION_EXPIRED, 401, true);
  }
}

export class SessionNotFoundError extends AppError {
  constructor(sessionName: string) {
    super(`Session '${sessionName}' not found`, ErrorCode.SESSION_NOT_FOUND, 404);
  }
}

export class SessionInvalidError extends AppError {
  constructor(message = 'Session is invalid') {
    super(message, ErrorCode.SESSION_INVALID, 401, true);
  }
}

export class CookieParseError extends AppError {
  constructor(message = 'Failed to parse cookies') {
    super(message, ErrorCode.COOKIE_PARSE_ERROR, 400);
  }
}

export class BrowserError extends AppError {
  constructor(message: string) {
    super(message, ErrorCode.BROWSER_ERROR, 500);
  }
}

export class NavigationError extends AppError {
  constructor(message: string) {
    super(message, ErrorCode.NAVIGATION_ERROR, 500);
  }
}

export class ElementNotFoundError extends AppError {
  constructor(selector: string) {
    super(`Element not found: ${selector}`, ErrorCode.ELEMENT_NOT_FOUND, 500);
  }
}

export class ScrapeError extends AppError {
  constructor(message: string) {
    super(message, ErrorCode.SCRAPE_ERROR, 500);
  }
}

export class MessageSendError extends AppError {
  constructor(message: string) {
    super(message, ErrorCode.MESSAGE_SEND_ERROR, 500);
  }
}

export class UserNotFoundError extends AppError {
  constructor(username: string) {
    super(`User '${username}' not found`, ErrorCode.USER_NOT_FOUND, 404);
  }
}

export class RateLimitedError extends AppError {
  constructor(message = 'Rate limited by Facebook') {
    super(message, ErrorCode.RATE_LIMITED, 429);
  }
}

export class AuthError extends AppError {
  constructor(message = 'Authentication failed') {
    super(message, ErrorCode.AUTH_ERROR, 401);
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, ErrorCode.VALIDATION_ERROR, 400);
  }
}
