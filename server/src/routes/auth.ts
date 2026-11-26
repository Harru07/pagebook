import { Router } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "../lib/asyncHandler";
import { sendVerificationEmail } from "../lib/mailer";
import { authenticate } from "../middleware/auth";

const router = Router();

const registerSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(255),
  email: z.string().trim().toLowerCase().email("Invalid email"),
  password: z.string().min(8, "Password must be at least 8 characters").max(100),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

router.post(
  "/register",
  asyncHandler(async (req, res) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }
    const { name, email, password } = parsed.data;

    const exists = await prisma.users.findFirst({ where: { email } });
    if (exists) return res.status(409).json({ error: "Email already registered" });

    const verificationToken = crypto.randomBytes(32).toString("hex");
    const user = await prisma.users.create({
      data: {
        name,
        email,
        password_hash: await bcrypt.hash(password, 12),
        verification_token: verificationToken,
      },
    });

    await sendVerificationEmail(user.email, user.name, verificationToken);
    res.status(201).json({
      message: "Registration successful! Please check your email to verify your account.",
    });
  }),
);

router.get(
  "/verify-email",
  asyncHandler(async (req, res) => {
    const { token } = req.query;
    // Guard: an undefined token in a Prisma "where" would match EVERY user.
    if (typeof token !== "string" || token.length === 0) {
      return res.status(400).json({ error: "Invalid or expired token" });
    }
    const result = await prisma.users.updateMany({
      where: { verification_token: token },
      data: { email_verified: true, verification_token: null },
    });
    if (result.count === 0) {
      return res.status(400).json({ error: "Invalid or expired token" });
    }
    res.json({ message: "Email verified successfully" });
  }),
);

router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Email and password are required" });
    }
    const { email, password } = parsed.data;

    const user = await prisma.users.findFirst({ where: { email } });
    const valid = user ? await bcrypt.compare(password, user.password_hash) : false;
    if (!user || !valid) return res.status(401).json({ error: "Invalid credentials" });

    if (!user.email_verified) {
      return res.status(403).json({ error: "Please verify your email before logging in." });
    }

    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET!, {
      expiresIn: (process.env.JWT_EXPIRES_IN ?? "7d") as jwt.SignOptions["expiresIn"],
    });
    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  }),
);

router.get("/me", authenticate, (req, res) => {
  res.json({ user: req.user });
});

export default router;
