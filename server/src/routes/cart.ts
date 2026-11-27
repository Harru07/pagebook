import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "../lib/asyncHandler";
import { isUuid } from "../lib/uuid";
import { authenticate } from "../middleware/auth";

const router = Router();

// Every cart route needs a logged-in user.
router.use(authenticate);

const addSchema = z.object({
  book_id: z.string().refine(isUuid, "Invalid book id"),
  quantity: z.coerce.number().int().min(1).max(99).default(1),
});

const updateSchema = z.object({
  quantity: z.coerce.number().int().min(1, "Use DELETE to remove an item").max(99),
});

// Builds the full cart response: items with book details, plus totals.
async function buildCart(userId: string) {
  const items = await prisma.cart_items.findMany({
    where: { user_id: userId },
    orderBy: { added_at: "asc" },
  });

  const bookIds = items.map((i) => i.book_id).filter((id): id is string => id != null);
  const books = await prisma.books.findMany({ where: { id: { in: bookIds } } });
  const bookById = new Map(books.map((b) => [b.id, b]));

  const lines = items.flatMap((item) => {
    const book = item.book_id ? bookById.get(item.book_id) : undefined;
    if (!book) return [];
    const price = Number(book.price);
    return [
      {
        id: item.id,
        book_id: book.id,
        quantity: item.quantity,
        title: book.title,
        author: book.author,
        cover_url: book.cover_url,
        price,
        stock: book.stock ?? 0,
        line_total: Math.round(price * item.quantity * 100) / 100,
      },
    ];
  });

  const subtotal = Math.round(lines.reduce((sum, l) => sum + l.line_total, 0) * 100) / 100;
  const item_count = lines.reduce((sum, l) => sum + l.quantity, 0);
  return { items: lines, subtotal, item_count };
}

// GET /api/cart
router.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await buildCart(req.user!.id));
  }),
);

// POST /api/cart   { book_id, quantity? }  -> adds, or increases the quantity if already in the cart
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const parsed = addSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }
    const { book_id, quantity } = parsed.data;
    const userId = req.user!.id;

    const book = await prisma.books.findFirst({ where: { id: book_id } });
    if (!book) return res.status(404).json({ error: "Book not found" });

    const stock = book.stock ?? 0;
    if (stock <= 0) return res.status(400).json({ error: "This book is out of stock" });

    const existing = await prisma.cart_items.findFirst({ where: { user_id: userId, book_id } });
    const newQuantity = (existing?.quantity ?? 0) + quantity;
    if (newQuantity > stock) {
      return res.status(400).json({ error: `Only ${stock} in stock` });
    }

    if (existing) {
      await prisma.cart_items.update({ where: { id: existing.id }, data: { quantity: newQuantity } });
    } else {
      await prisma.cart_items.create({ data: { user_id: userId, book_id, quantity } });
    }
    res.status(existing ? 200 : 201).json(await buildCart(userId));
  }),
);

// PUT /api/cart/:bookId   { quantity }  -> sets the quantity exactly
router.put(
  "/:bookId",
  asyncHandler(async (req, res) => {
    const bookId = String(req.params.bookId);
    if (!isUuid(bookId)) return res.status(404).json({ error: "Item not in cart" });

    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }
    const userId = req.user!.id;

    const item = await prisma.cart_items.findFirst({ where: { user_id: userId, book_id: bookId } });
    if (!item) return res.status(404).json({ error: "Item not in cart" });

    const book = await prisma.books.findFirst({ where: { id: bookId } });
    const stock = book?.stock ?? 0;
    if (parsed.data.quantity > stock) {
      return res.status(400).json({ error: `Only ${stock} in stock` });
    }

    await prisma.cart_items.update({ where: { id: item.id }, data: { quantity: parsed.data.quantity } });
    res.json(await buildCart(userId));
  }),
);

// DELETE /api/cart/:bookId  -> removes one book from the cart
router.delete(
  "/:bookId",
  asyncHandler(async (req, res) => {
    const bookId = String(req.params.bookId);
    if (!isUuid(bookId)) return res.status(404).json({ error: "Item not in cart" });

    const userId = req.user!.id;
    const result = await prisma.cart_items.deleteMany({ where: { user_id: userId, book_id: bookId } });
    if (result.count === 0) return res.status(404).json({ error: "Item not in cart" });

    res.json(await buildCart(userId));
  }),
);

// DELETE /api/cart  -> empties the cart
router.delete(
  "/",
  asyncHandler(async (req, res) => {
    await prisma.cart_items.deleteMany({ where: { user_id: req.user!.id } });
    res.json({ items: [], subtotal: 0, item_count: 0 });
  }),
);

export default router;
