import { Router } from "express";
import { z } from "zod";
import { Prisma } from "../generated/prisma/client";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "../lib/asyncHandler";
import { serializeBook } from "../lib/serialize";
import { authenticate, requireAdmin } from "../middleware/auth";

const router = Router();

const isUuid = (value: string) => z.string().uuid().safeParse(value).success;

// ---------- Validation ----------

const listQuerySchema = z.object({
  search: z.string().trim().optional(),
  genre: z.string().trim().optional(), // genre slug, e.g. "fantasy"
  min_price: z.coerce.number().min(0).optional(),
  max_price: z.coerce.number().min(0).optional(),
  featured: z.enum(["true", "false"]).optional(),
  bestseller: z.enum(["true", "false"]).optional(),
  new_arrival: z.enum(["true", "false"]).optional(),
  sort: z
    .enum(["price", "title", "average_rating", "created_at", "review_count"])
    .default("created_at"),
  order: z
    .string()
    .default("desc")
    .transform((v) => (v.toLowerCase() === "asc" ? "asc" : "desc") as "asc" | "desc"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(12),
});

const bookSchema = z.object({
  title: z.string().trim().min(1).max(500),
  author: z.string().trim().min(1).max(255),
  isbn: z.string().trim().max(20).nullish(),
  genre_id: z.coerce.number().int().nullish(),
  price: z.coerce.number().positive(),
  original_price: z.coerce.number().positive().nullish(),
  stock: z.coerce.number().int().min(0),
  description: z.string().nullish(),
  cover_url: z.string().url().nullish(),
  publisher: z.string().trim().max(255).nullish(),
  published_year: z.coerce.number().int().min(0).max(2100).nullish(),
  pages: z.coerce.number().int().positive().nullish(),
  language: z.string().trim().max(50),
  featured: z.boolean(),
  bestseller: z.boolean(),
  new_arrival: z.boolean(),
});

// Creating needs title, author, price. Everything else is optional and the
// database fills in its own defaults (stock 0, language English, flags false).
const createBookSchema = bookSchema
  .partial()
  .required({ title: true, author: true, price: true });
const updateBookSchema = bookSchema.partial();

// ---------- Routes ----------

// GET /api/books?search=&genre=&min_price=&max_price=&sort=&order=&page=&limit=
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }
    const q = parsed.data;

    const where: Prisma.booksWhereInput = {};

    if (q.search) {
      where.OR = [
        { title: { contains: q.search, mode: "insensitive" } },
        { author: { contains: q.search, mode: "insensitive" } },
      ];
    }
    if (q.genre) {
      const genre = await prisma.genres.findFirst({ where: { slug: q.genre } });
      // Unknown slug: use an id that can't match so the result is simply empty.
      where.genre_id = genre ? genre.id : -1;
    }
    if (q.min_price !== undefined || q.max_price !== undefined) {
      where.price = { gte: q.min_price, lte: q.max_price };
    }
    if (q.featured === "true") where.featured = true;
    if (q.bestseller === "true") where.bestseller = true;
    if (q.new_arrival === "true") where.new_arrival = true;

    // Sort by the chosen column, with id as a tie-breaker so pages never overlap.
    const orderBy = [{ [q.sort]: q.order }, { id: "asc" }] as Prisma.booksOrderByWithRelationInput[];

    const [total, books] = await Promise.all([
      prisma.books.count({ where }),
      prisma.books.findMany({
        where,
        orderBy,
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
    ]);

    // Attach genre info (one extra query for all genres on this page).
    const genreIds = [...new Set(books.map((b) => b.genre_id).filter((id): id is number => id != null))];
    const genres = await prisma.genres.findMany({ where: { id: { in: genreIds } } });
    const genreById = new Map(genres.map((g) => [g.id, g]));

    res.json({
      books: books.map((b) => serializeBook(b, b.genre_id != null ? genreById.get(b.genre_id) : null)),
      total,
      page: q.page,
      limit: q.limit,
      totalPages: Math.ceil(total / q.limit),
    });
  }),
);

// GET /api/books/:id
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    if (!isUuid(id)) return res.status(404).json({ error: "Book not found" });

    const book = await prisma.books.findFirst({ where: { id } });
    if (!book) return res.status(404).json({ error: "Book not found" });

    const genre = book.genre_id != null ? await prisma.genres.findFirst({ where: { id: book.genre_id } }) : null;
    res.json(serializeBook(book, genre));
  }),
);

// POST /api/books  (admin only)
router.post(
  "/",
  authenticate,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const parsed = createBookSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }
    const data = parsed.data;

    if (data.genre_id != null) {
      const genre = await prisma.genres.findFirst({ where: { id: data.genre_id } });
      if (!genre) return res.status(400).json({ error: "Genre not found" });
    }

    const book = await prisma.books.create({ data });
    res.status(201).json(serializeBook(book));
  }),
);

// PUT /api/books/:id  (admin only, send only the fields you want to change)
router.put(
  "/:id",
  authenticate,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    if (!isUuid(id)) return res.status(404).json({ error: "Book not found" });

    const parsed = updateBookSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }
    if (Object.keys(parsed.data).length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }
    if (parsed.data.genre_id != null) {
      const genre = await prisma.genres.findFirst({ where: { id: parsed.data.genre_id } });
      if (!genre) return res.status(400).json({ error: "Genre not found" });
    }

    const existing = await prisma.books.findFirst({ where: { id } });
    if (!existing) return res.status(404).json({ error: "Book not found" });

    const book = await prisma.books.update({
      where: { id },
      data: { ...parsed.data, updated_at: new Date() },
    });
    res.json(serializeBook(book));
  }),
);

// DELETE /api/books/:id  (admin only)
router.delete(
  "/:id",
  authenticate,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    if (!isUuid(id)) return res.status(404).json({ error: "Book not found" });

    const existing = await prisma.books.findFirst({ where: { id } });
    if (!existing) return res.status(404).json({ error: "Book not found" });

    try {
      await prisma.books.delete({ where: { id } });
    } catch (err) {
      // P2003 = foreign key violation: the book appears in past orders.
      if ((err as { code?: string }).code === "P2003") {
        return res
          .status(409)
          .json({ error: "This book is part of existing orders and cannot be deleted" });
      }
      throw err;
    }
    res.json({ message: "Book deleted" });
  }),
);

export default router;
