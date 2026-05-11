import type { FastifyRequest, FastifyReply } from 'fastify';
import { AuthError } from '../errors';
import { config } from '../config';
import jwt from 'jsonwebtoken';

export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers.authorization;

  if (!authHeader) {
    throw new AuthError('Missing authorization header');
  }

  // Support both API Key and JWT
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);

    // Check if it's an API key
    if (config.apiKeys.includes(token)) {
      return;
    }

    // Try JWT verification
    try {
      jwt.verify(token, config.jwtSecret);
      return;
    } catch {
      throw new AuthError('Invalid token');
    }
  }

  if (authHeader.startsWith('ApiKey ')) {
    const apiKey = authHeader.substring(7);
    if (config.apiKeys.includes(apiKey)) {
      return;
    }
    throw new AuthError('Invalid API key');
  }

  throw new AuthError('Invalid authorization format');
}
