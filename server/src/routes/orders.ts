import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "../lib/asyncHandler";
import { isUuid } from "../lib/uuid";
import { authenticate } from "../middleware/auth";

const router = Router();

// Every order route needs a logged-in user.
router.use(authenticate);

// Thrown inside a transaction to roll everything back with a message the user can read.
class OrderError extends Error {}

type OrderRow = Awaited<ReturnType<typeof prisma.orders.findFirstOrThrow>>;
const serializeOrder = (o: OrderRow) => ({
   ...o,
   total_price: Number(o.total_price),
});

const createOrderSchema = z.object({
   shipping_address: z.object({
      full_name: z.string().trim().min(1, "Full name is required").max(255),
      phone: z.string().trim().min(5, "Phone number is required").max(30),
      address_line: z.string().trim().min(1, "Address is required").max(500),
      city: z.string().trim().min(1, "City is required").max(100),
      province: z.string().trim().max(100).default(""),
      postal_code: z.string().trim().min(1, "Postal code is required").max(20),
   }),
   notes: z.string().trim().max(1000).nullish(),
});

// POST /api/orders  { shipping_address, notes? }
// Turns the user's cart into an order (cash on delivery for now).
// Prices come from the books table, never from the request.
router.post(
   "/",
   asyncHandler(async (req, res) => {
      const parsed = createOrderSchema.safeParse(req.body);
      if (!parsed.success) {
         const issue = parsed.error.issues[0];
         return res
            .status(400)
            .json({ error: `${issue.path.join(".")}: ${issue.message}` });
      }
      const userId = req.user!.id;

      try {
         // One transaction: either every step below succeeds, or none of it is saved.
         const order = await prisma.$transaction(async (tx) => {
            const cartItems = await tx.cart_items.findMany({
               where: { user_id: userId },
            });
            if (cartItems.length === 0) throw new OrderError("Cart is empty");

            const bookIds = cartItems
               .map((i) => i.book_id)
               .filter((id): id is string => id != null);
            const books = await tx.books.findMany({
               where: { id: { in: bookIds } },
            });
            const bookById = new Map(books.map((b) => [b.id, b]));

            let totalCents = 0;
            const lines: {
               book_id: string;
               quantity: number;
               unit_price: number;
            }[] = [];

            for (const item of cartItems) {
               const book = item.book_id
                  ? bookById.get(item.book_id)
                  : undefined;
               if (!book)
                  throw new OrderError(
                     "A book in your cart is no longer available",
                  );

               const unitPrice = Number(book.price);
               totalCents += Math.round(unitPrice * 100) * item.quantity;
               lines.push({
                  book_id: book.id,
                  quantity: item.quantity,
                  unit_price: unitPrice,
               });

               // Take the stock only if enough is left. The check and the decrement are one
               // statement, so two people buying the last copy can't both succeed.
               const taken = await tx.books.updateMany({
                  where: { id: book.id, stock: { gte: item.quantity } },
                  data: { stock: { decrement: item.quantity } },
               });
               if (taken.count === 0)
                  throw new OrderError(`Not enough stock for "${book.title}"`);
            }

            const created = await tx.orders.create({
               data: {
                  user_id: userId,
                  total_price: totalCents / 100,
                  shipping_address: parsed.data.shipping_address,
                  payment_method: "cod",
                  notes: parsed.data.notes ?? null,
               },
            });
            await tx.order_items.createMany({
               data: lines.map((l) => ({ order_id: created.id, ...l })),
            });
            await tx.cart_items.deleteMany({ where: { user_id: userId } });
            return created;
         });

         res.status(201).json(serializeOrder(order));
      } catch (err) {
         if (err instanceof OrderError)
            return res.status(400).json({ error: err.message });
         throw err;
      }
   }),
);

// GET /api/orders  -> the current user's orders, newest first
router.get(
   "/",
   asyncHandler(async (req, res) => {
      const orders = await prisma.orders.findMany({
         where: { user_id: req.user!.id },
         orderBy: { created_at: "desc" },
      });
      const counts = await prisma.order_items.groupBy({
         by: ["order_id"],
         where: { order_id: { in: orders.map((o) => o.id) } },
         _sum: { quantity: true },
      });
      const countByOrder = new Map(
         counts.map((c) => [c.order_id, c._sum.quantity ?? 0]),
      );

      res.json(
         orders.map((o) => ({
            ...serializeOrder(o),
            item_count: countByOrder.get(o.id) ?? 0,
         })),
      );
   }),
);

// GET /api/orders/:id  -> one order with its items (only if it belongs to the user)
router.get(
   "/:id",
   asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      if (!isUuid(id))
         return res.status(404).json({ error: "Order not found" });

      const order = await prisma.orders.findFirst({
         where: { id, user_id: req.user!.id },
      });
      if (!order) return res.status(404).json({ error: "Order not found" });

      const items = await prisma.order_items.findMany({
         where: { order_id: id },
      });
      const bookIds = items
         .map((i) => i.book_id)
         .filter((b): b is string => b != null);
      const books = await prisma.books.findMany({
         where: { id: { in: bookIds } },
      });
      const bookById = new Map(books.map((b) => [b.id, b]));

      res.json({
         ...serializeOrder(order),
         items: items.map((i) => {
            const book = i.book_id ? bookById.get(i.book_id) : undefined;
            const unitPrice = Number(i.unit_price);
            return {
               id: i.id,
               book_id: i.book_id,
               title: book?.title ?? null,
               author: book?.author ?? null,
               cover_url: book?.cover_url ?? null,
               quantity: i.quantity,
               unit_price: unitPrice,
               line_total: Math.round(unitPrice * i.quantity * 100) / 100,
            };
         }),
      });
   }),
);

// PUT /api/orders/:id/cancel
// Users can cancel only while the order is still "pending". The stock goes back on the shelf.
// (Cancelling an already-paid order needs a refund, which we add with online payments.)
router.put(
   "/:id/cancel",
   asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      if (!isUuid(id))
         return res.status(404).json({ error: "Order not found" });
      const userId = req.user!.id;

      try {
         const order = await prisma.$transaction(async (tx) => {
            const result = await tx.orders.updateMany({
               where: { id, user_id: userId, status: "pending" },
               data: { status: "cancelled", updated_at: new Date() },
            });
            if (result.count === 0)
               throw new OrderError(
                  "Order not found or can no longer be cancelled",
               );

            const items = await tx.order_items.findMany({
               where: { order_id: id },
            });
            for (const item of items) {
               if (item.book_id) {
                  await tx.books.update({
                     where: { id: item.book_id },
                     data: { stock: { increment: item.quantity } },
                  });
               }
            }
            return tx.orders.findFirstOrThrow({ where: { id } });
         });

         res.json({ message: "Order cancelled", order: serializeOrder(order) });
      } catch (err) {
         if (err instanceof OrderError)
            return res.status(400).json({ error: err.message });
         throw err;
      }
   }),
);

export default router;
