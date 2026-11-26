import { prisma } from "./prisma";

type BookRow = Awaited<ReturnType<typeof prisma.books.findFirstOrThrow>>;
type GenreRow = Awaited<ReturnType<typeof prisma.genres.findFirstOrThrow>>;

// Prisma returns Postgres numeric columns as Decimal objects, which turn into
// strings in JSON. Convert them to plain numbers so the frontend gets 349.5, not "349.50".
const toNumber = (v: unknown) => (v == null ? null : Number(v));

export function serializeBook(book: BookRow, genre?: GenreRow | null) {
  return {
    ...book,
    price: Number(book.price),
    original_price: toNumber(book.original_price),
    average_rating: Number(book.average_rating ?? 0),
    genre_name: genre?.name ?? null,
    genre_slug: genre?.slug ?? null,
    genre_color: genre?.color ?? null,
  };
}
