import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "../lib/asyncHandler";
import { authenticate, requireAdmin } from "../middleware/auth";

const router = Router();

const genreSchema = z.object({
  name: z.string().trim().min(1).max(100),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/, "Slug may only contain lowercase letters, numbers and hyphens"),
  description: z.string().trim().nullish(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Color must look like #1a2b3c")
    .nullish(),
});

// GET /api/genres  ->  every genre plus how many books it has
router.get(
  "/",
  asyncHandler(async (_req, res) => {
    const [genres, counts] = await Promise.all([
      prisma.genres.findMany({ orderBy: { name: "asc" } }),
      prisma.books.groupBy({ by: ["genre_id"], _count: { _all: true } }),
    ]);
    const countByGenre = new Map(counts.map((c) => [c.genre_id, c._count._all]));
    res.json(genres.map((g) => ({ ...g, book_count: countByGenre.get(g.id) ?? 0 })));
  }),
);

// POST /api/genres  (admin only)
router.post(
  "/",
  authenticate,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const parsed = genreSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }
    const slugTaken = await prisma.genres.findFirst({ where: { slug: parsed.data.slug } });
    if (slugTaken) return res.status(409).json({ error: "A genre with that slug already exists" });

    const genre = await prisma.genres.create({ data: parsed.data });
    res.status(201).json(genre);
  }),
);

export default router;
