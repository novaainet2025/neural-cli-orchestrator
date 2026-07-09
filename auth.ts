// JWT Authentication Middleware with Refresh Token Support
import { Request, Response, NextFunction } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';

interface AuthRequest extends Request {
  userId?: string;
  role?: string;
}

// Access token secret (should be stored in environment variables)
const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'access_token_secret';
// Refresh token secret
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || 'refresh_token_secret';
// Access token expiry (e.g., 15 minutes)
const ACCESS_TOKEN_EXPIRY = '15m';
// Refresh token expiry (e.g., 7 days)
const REFRESH_TOKEN_EXPIRY = '7d';

/**
 * Generate access token
 */
export const generateAccessToken = (userId: string, role: string = 'user'): string => {
  return jwt.sign({ userId, role }, ACCESS_TOKEN_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
};

/**
 * Generate refresh token
 */
export const generateRefreshToken = (userId: string, role: string = 'user'): string => {
  return jwt.sign({ userId, role }, REFRESH_TOKEN_SECRET, { expiresIn: REFRESH_TOKEN_EXPIRY });
};

/**
 * Verify access token middleware
 */
export const authenticateJWT = (req: AuthRequest, res: Response, next: NextFunction): void => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    res.status(401).json({ message: 'Access token required' });
    return;
  }

  const token = authHeader.split(' ')[1]; // Bearer <token>
  if (!token) {
    res.status(401).json({ message: 'Invalid token format' });
    return;
  }

  try {
    const decoded = jwt.verify(token, ACCESS_TOKEN_SECRET) as JwtPayload;
    if (decoded.userId) {
      req.userId = decoded.userId;
      req.role = decoded.role || 'user';
      next();
    } else {
      res.status(401).json({ message: 'Invalid token payload' });
    }
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      res.status(401).json({ message: 'Invalid or expired token' });
    } else {
      res.status(401).json({ message: 'Token verification failed' });
    }
  }
};

/**
 * Verify refresh token middleware (used for refresh endpoint)
 */
export const authenticateRefreshJWT = (req: AuthRequest, res: Response, next: NextFunction): void => {
  const { refreshToken } = req.body; // Expect refreshToken in body for refresh endpoint

  if (!refreshToken) {
    res.status(401).json({ message: 'Refresh token required' });
    return;
  }

  try {
    const decoded = jwt.verify(refreshToken, REFRESH_TOKEN_SECRET) as JwtPayload;
    if (decoded.userId) {
      req.userId = decoded.userId;
      req.role = decoded.role || 'user';
      next();
    } else {
      res.status(401).json({ message: 'Invalid refresh token payload' });
    }
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      res.status(401).json({ message: 'Invalid or expired refresh token' });
    } else {
      res.status(401).json({ message: 'Refresh token verification failed' });
    }
  }
};

/**
 * Optional: Middleware to attach user info if token present (does not require auth)
 */
export const optionalAuth = (req: AuthRequest, res: Response, next: NextFunction): void => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return next();
  }

  const token = authHeader.split(' ')[1];
  if (!token) {
    return next();
  }

  try {
    const decoded = jwt.verify(token, ACCESS_TOKEN_SECRET) as JwtPayload;
    if (decoded.userId) {
      req.userId = decoded.userId;
      req.role = decoded.role || 'user';
    }
    next();
  } catch {
    // Invalid token, treat as unauthenticated but continue
    next();
  }
};

export default {
  authenticateJWT,
  authenticateRefreshJWT,
  optionalAuth,
  generateAccessToken,
  generateRefreshToken
};