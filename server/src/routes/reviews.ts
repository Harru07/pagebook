import { Router } from "express";
import { z } from "zod";
import { Prisma } from "../generated/prisma/client";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "../lib/asyncHandler";
import { isUuid } from "../lib/uuid";
import { authenticate } from "../middleware/auth";

// Mounted at /api/books, so these become /api/books/:id/reviews
const router = Router();

const reviewSchema = z.object({
  rating: z.coerce.number().int().min(1, "Rating must be 1 to 5").max(5, "Rating must be 1 to 5"),
  comment: z.string().trim().max(2000).nullish(),
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

// Recalculates a book's average rating and review count from its reviews.
// Runs inside the same transaction as the change, so the numbers never drift.
async function refreshBookRating(tx: Prisma.TransactionClient, bookId: string) {
  const agg = await tx.reviews.aggregate({
    where: { book_id: bookId },
    _avg: { rating: true },
    _count: { _all: true },
  });
  const average_rating = Math.round((agg._avg.rating ?? 0) * 100) / 100;
  const review_count = agg._count._all;
  await tx.books.update({ where: { id: bookId }, data: { average_rating, review_count } });
  return { average_rating, review_count };
}

// GET /api/books/:id/reviews?page=&limit=   (public)
router.get(
  "/:id/reviews",
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    if (!isUuid(id)) return res.status(404).json({ error: "Book not found" });

    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
    const q = parsed.data;

    const book = await prisma.books.findFirst({ where: { id } });
    if (!book) return res.status(404).json({ error: "Book not found" });

    const where = { book_id: id };
    const [total, reviews] = await Promise.all([
      prisma.reviews.count({ where }),
      prisma.reviews.findMany({
        where,
        orderBy: { created_at: "desc" },
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
    ]);

    const userIds = [...new Set(reviews.map((r) => r.user_id).filter((u): u is string => u != null))];
    const users = await prisma.users.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } });
    const nameById = new Map(users.map((u) => [u.id, u.name]));

    res.json({
      reviews: reviews.map((r) => ({ ...r, user_name: r.user_id ? (nameById.get(r.user_id) ?? null) : null })),
      average_rating: Number(book.average_rating ?? 0),
      review_count: book.review_count ?? 0,
      total,
      page: q.page,
      limit: q.limit,
      totalPages: Math.ceil(total / q.limit),
    });
  }),
);

// POST /api/books/:id/reviews   { rating, comment? }   (login required)
// One review per user per book: posting again updates your existing review.
router.post(
  "/:id/reviews",
  authenticate,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    if (!isUuid(id)) return res.status(404).json({ error: "Book not found" });

    const parsed = reviewSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
    const { rating } = parsed.data;
    const comment = parsed.data.comment || null;

    const book = await prisma.books.findFirst({ where: { id } });
    if (!book) return res.status(404).json({ error: "Book not found" });

    const userId = req.user!.id;
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.reviews.findFirst({ where: { user_id: userId, book_id: id } });
      const review = existing
        ? await tx.reviews.update({ where: { id: existing.id }, data: { rating, comment } })
        : await tx.reviews.create({ data: { user_id: userId, book_id: id, rating, comment } });
      const summary = await refreshBookRating(tx, id);
      return { review, summary, created: !existing };
    });

    res.status(result.created ? 201 : 200).json({
      ...result.review,
      user_name: req.user!.name,
      ...result.summary,
    });
  }),
);

// DELETE /api/books/:id/reviews   (deletes YOUR review of this book)
router.delete(
  "/:id/reviews",
  authenticate,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    if (!isUuid(id)) return res.status(404).json({ error: "Book not found" });

    const summary = await prisma.$transaction(async (tx) => {
      const removed = await tx.reviews.deleteMany({ where: { user_id: req.user!.id, book_id: id } });
      if (removed.count === 0) return null;
      return refreshBookRating(tx, id);
    });
    if (!summary) return res.status(404).json({ error: "You haven't reviewed this book" });

    res.json({ message: "Review deleted", ...summary });
  }),
);

export default router;
