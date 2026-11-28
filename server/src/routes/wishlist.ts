import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "../lib/asyncHandler";
import { isUuid } from "../lib/uuid";
import { authenticate } from "../middleware/auth";

const router = Router();

// Every wishlist route needs a logged-in user.
router.use(authenticate);

const addSchema = z.object({
  book_id: z.string().refine(isUuid, "Invalid book id"),
});

// The user's saved books, newest first, with the book details the UI needs.
async function buildWishlist(userId: string) {
  const items = await prisma.wishlist.findMany({
    where: { user_id: userId },
    orderBy: { added_at: "desc" },
  });
  const bookIds = items.map((i) => i.book_id).filter((b): b is string => b != null);
  const books = await prisma.books.findMany({ where: { id: { in: bookIds } } });
  const bookById = new Map(books.map((b) => [b.id, b]));

  return items.flatMap((item) => {
    const book = item.book_id ? bookById.get(item.book_id) : undefined;
    if (!book) return [];
    return [
      {
        id: item.id,
        added_at: item.added_at,
        book: {
          id: book.id,
          title: book.title,
          author: book.author,
          cover_url: book.cover_url,
          price: Number(book.price),
          stock: book.stock ?? 0,
          average_rating: Number(book.average_rating ?? 0),
        },
      },
    ];
  });
}

// GET /api/wishlist
router.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await buildWishlist(req.user!.id));
  }),
);

// POST /api/wishlist   { book_id }   (adding a book that's already saved is fine)
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const parsed = addSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
    const { book_id } = parsed.data;
    const userId = req.user!.id;

    const book = await prisma.books.findFirst({ where: { id: book_id } });
    if (!book) return res.status(404).json({ error: "Book not found" });

    const existing = await prisma.wishlist.findFirst({ where: { user_id: userId, book_id } });
    if (!existing) await prisma.wishlist.create({ data: { user_id: userId, book_id } });

    res.status(existing ? 200 : 201).json(await buildWishlist(userId));
  }),
);

// DELETE /api/wishlist/:bookId
router.delete(
  "/:bookId",
  asyncHandler(async (req, res) => {
    const bookId = String(req.params.bookId);
    if (!isUuid(bookId)) return res.status(404).json({ error: "Book not in wishlist" });

    const userId = req.user!.id;
    const removed = await prisma.wishlist.deleteMany({ where: { user_id: userId, book_id: bookId } });
    if (removed.count === 0) return res.status(404).json({ error: "Book not in wishlist" });

    res.json(await buildWishlist(userId));
  }),
);

export default router;
