// JWT authentication middleware for Express.js (compatible with Fastify style)
import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

const ACCESS_SECRET = process.env.ACCESS_TOKEN_SECRET;
const REFRESH_SECRET = process.env.REFRESH_TOKEN_SECRET;

if (!ACCESS_SECRET || !REFRESH_SECRET) {
  throw new Error("FATAL: ACCESS_TOKEN_SECRET/REFRESH_TOKEN_SECRET must be set");
}

// Types for payloads
interface AccessTokenPayload {
  sub: string; // user id
  iat: number;
  exp: number;
}
interface RefreshTokenPayload extends AccessTokenPayload {
  // can include additional fields if needed
}

/**
 * Verify access token from Authorization header.
 * Throws 401 if invalid.
 */
export function verifyAccessToken(
  req: Request,
  _res: Response,
  next: NextFunction
) {
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return next(new Error("Missing or malformed Authorization header"));
  }
  const token = authHeader.split(" ")[1];
  try {
    const payload = jwt.verify(token, ACCESS_SECRET, {
      algorithms: ["HS256"],
    }) as AccessTokenPayload;
    // Attach user id to request for downstream handlers
    (req as any).userId = payload.sub;
    return next();
  } catch (err) {
    return next(new Error("Invalid or expired access token"));
  }
}

/**
 * Issue new access token using a valid refresh token.
 * Expects refresh token in request body { refreshToken: string }.
 */
export function refreshAccessToken(req: Request, res: Response) {
  const { refreshToken } = req.body as { refreshToken?: string };
  if (!refreshToken) {
    return res.status(400).json({ error: "Refresh token required" });
  }
  try {
    const payload = jwt.verify(refreshToken, REFRESH_SECRET, {
      algorithms: ["HS256"],
    }) as RefreshTokenPayload;
    const newAccess = jwt.sign({ sub: payload.sub }, ACCESS_SECRET, {
      expiresIn: "15m",
      algorithm: "HS256",
    });
    return res.json({ accessToken: newAccess });
  } catch (err) {
    return res.status(401).json({ error: "Invalid refresh token" });
  }
}
