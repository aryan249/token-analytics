import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { verifyMessage } from "viem";
import type { RedisClient } from "../clients/redis";
import { logger } from "../utils/logger";

const NONCE_TTL = 300; // 5 minutes
const nonceKey = (wallet: string) => `auth:nonce:${wallet.toLowerCase()}`;

interface AuthOpts {
  redis:     RedisClient;
  jwtSecret: string;
  jwtExpiry: string;
}

export interface JwtPayload {
  wallet: string;
  iat:    number;
  exp:    number;
}

export function verifyJwt(token: string, secret: string): JwtPayload | null {
  try {
    return jwt.verify(token, secret) as JwtPayload;
  } catch {
    return null;
  }
}

export const authRoutes: FastifyPluginAsync<AuthOpts> = async (app, { redis, jwtSecret, jwtExpiry }) => {

  // GET /auth/nonce?wallet=0x...
  app.get<{ Querystring: { wallet?: string } }>("/nonce", async (req, reply) => {
    const wallet = req.query.wallet?.toLowerCase();
    if (!wallet || !/^0x[a-f0-9]{40}$/.test(wallet)) {
      return reply.status(400).send({ error: "Valid wallet address required" });
    }

    const nonce = crypto.randomBytes(32).toString("hex");
    await redis.setEx(nonceKey(wallet), NONCE_TTL, nonce);

    return reply.send({
      nonce,
      message: `Sign this message to authenticate with FLaunch Analytics:\n\n${nonce}`,
    });
  });

  // POST /auth/login { wallet, signature }
  app.post<{ Body: { wallet?: string; signature?: string } }>("/login", async (req, reply) => {
    const wallet    = req.body?.wallet?.toLowerCase();
    const signature = req.body?.signature;

    if (!wallet || !signature) {
      return reply.status(400).send({ error: "wallet and signature required" });
    }

    const storedNonce = await redis.get(nonceKey(wallet));
    if (!storedNonce) {
      return reply.status(401).send({ error: "Nonce expired or not found. Request a new nonce." });
    }

    const message = `Sign this message to authenticate with FLaunch Analytics:\n\n${storedNonce}`;

    try {
      const valid = await verifyMessage({
        address:   wallet as `0x${string}`,
        message,
        signature: signature as `0x${string}`,
      });

      if (!valid) {
        return reply.status(401).send({ error: "Invalid signature" });
      }
    } catch {
      return reply.status(401).send({ error: "Signature verification failed" });
    }

    // Delete nonce (single use)
    await redis.del(nonceKey(wallet));

    const token = jwt.sign({ wallet }, jwtSecret, { expiresIn: jwtExpiry } as jwt.SignOptions);

    logger.info({ wallet }, "User authenticated");
    return reply.send({ token, wallet });
  });
};

export function jwtAuthHook(jwtSecret: string) {
  const PUBLIC_PATHS = new Set(["/health", "/metrics", "/auth/nonce", "/auth/login"]);
  const STATIC_EXTENSIONS = new Set([".html", ".css", ".js", ".ico", ".png", ".svg", ".json"]);

  // Public GET routes — analytics data that anyone can read without auth
  const PUBLIC_GET_PREFIXES = [
    "/tokens",
    "/stats",
  ];

  return async (req: FastifyRequest, reply: FastifyReply) => {
    const path = req.url.split("?")[0];

    // Always public: health, auth, websocket, static files, root
    if (PUBLIC_PATHS.has(path) || path === "/ws" || path === "/") return;
    const ext = path.substring(path.lastIndexOf("."));
    if (STATIC_EXTENSIONS.has(ext)) return;

    // Public GET routes: token data + stats are public read-only
    // User-specific routes (/users/:wallet/*) require auth
    if (req.method === "GET" && PUBLIC_GET_PREFIXES.some(p => path.startsWith(p))) return;

    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return reply.status(401).send({ error: "Missing Authorization header" });
    }

    const payload = verifyJwt(header.slice(7), jwtSecret);
    if (!payload) {
      return reply.status(401).send({ error: "Invalid or expired token" });
    }

    (req as any).wallet = payload.wallet;
  };
}
