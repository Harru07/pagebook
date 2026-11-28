import { Router } from "express";
import { z } from "zod";
import { Prisma } from "../generated/prisma/client";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "../lib/asyncHandler";
import { isUuid } from "../lib/uuid";
import { authenticate, requireAdmin } from "../middleware/auth";

const router = Router();

// Every route here needs a logged-in admin.
router.use(authenticate, requireAdmin);

class AdminOrderError extends Error {
  constructor(
    message: string,
    public statusCode = 400,
  ) {
    super(message);
  }
}

type OrderRow = Awaited<ReturnType<typeof prisma.orders.findFirstOrThrow>>;
const serializeOrder = (o: OrderRow) => ({ ...o, total_price: Number(o.total_price) });

const STATUSES = ["pending", "confirmed", "processing", "shipped", "delivered", "cancelled", "refunded"] as const;

// The order lifecycle. An order can only move along these arrows.
// "delivered", "cancelled" and "refunded" are end states.
const TRANSITIONS: Record<string, string[]> = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["processing", "cancelled"],
  processing: ["shipped", "cancelled"],
  shipped: ["delivered"],
  delivered: [],
  cancelled: [],
  refunded: [],
};

const listQuerySchema = z.object({
  status: z.enum(STATUSES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const statusBodySchema = z.object({ status: z.enum(STATUSES) });

// GET /api/admin/orders?status=&page=&limit=
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }
    const q = parsed.data;
    const where: Prisma.ordersWhereInput = q.status ? { status: q.status } : {};

    const [total, orders] = await Promise.all([
      prisma.orders.count({ where }),
      prisma.orders.findMany({
        where,
        orderBy: { created_at: "desc" },
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
    ]);

    const userIds = [...new Set(orders.map((o) => o.user_id).filter((id): id is string => id != null))];
    const [users, counts] = await Promise.all([
      prisma.users.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }),
      prisma.order_items.groupBy({
        by: ["order_id"],
        where: { order_id: { in: orders.map((o) => o.id) } },
        _sum: { quantity: true },
      }),
    ]);
    const userById = new Map(users.map((u) => [u.id, u]));
    const countByOrder = new Map(counts.map((c) => [c.order_id, c._sum.quantity ?? 0]));

    res.json({
      orders: orders.map((o) => {
        const user = o.user_id ? userById.get(o.user_id) : undefined;
        return {
          ...serializeOrder(o),
          customer_name: user?.name ?? null,
          customer_email: user?.email ?? null,
          item_count: countByOrder.get(o.id) ?? 0,
        };
      }),
      total,
      page: q.page,
      limit: q.limit,
      totalPages: Math.ceil(total / q.limit),
    });
  }),
);

// GET /api/admin/orders/:id  -> any order, with items, customer, and which statuses it can move to
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    if (!isUuid(id)) return res.status(404).json({ error: "Order not found" });

    const order = await prisma.orders.findFirst({ where: { id } });
    if (!order) return res.status(404).json({ error: "Order not found" });

    const [items, user] = await Promise.all([
      prisma.order_items.findMany({ where: { order_id: id } }),
      order.user_id
        ? prisma.users.findFirst({ where: { id: order.user_id }, select: { name: true, email: true } })
        : null,
    ]);
    const bookIds = items.map((i) => i.book_id).filter((b): b is string => b != null);
    const books = await prisma.books.findMany({ where: { id: { in: bookIds } } });
    const bookById = new Map(books.map((b) => [b.id, b]));

    res.json({
      ...serializeOrder(order),
      customer_name: user?.name ?? null,
      customer_email: user?.email ?? null,
      allowed_next: TRANSITIONS[order.status ?? "pending"] ?? [],
      items: items.map((i) => {
        const book = i.book_id ? bookById.get(i.book_id) : undefined;
        const unitPrice = Number(i.unit_price);
        return {
          id: i.id,
          book_id: i.book_id,
          title: book?.title ?? null,
          quantity: i.quantity,
          unit_price: unitPrice,
          line_total: Math.round(unitPrice * i.quantity * 100) / 100,
        };
      }),
    });
  }),
);

// PUT /api/admin/orders/:id/status  { status }
router.put(
  "/:id/status",
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    if (!isUuid(id)) return res.status(404).json({ error: "Order not found" });

    const parsed = statusBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: `status must be one of: ${STATUSES.join(", ")}` });
    }
    const next = parsed.data.status;

    try {
      const order = await prisma.$transaction(async (tx) => {
        const current = await tx.orders.findFirst({ where: { id } });
        if (!current) throw new AdminOrderError("Order not found", 404);

        const from = current.status ?? "pending";
        if (!(TRANSITIONS[from] ?? []).includes(next)) {
          throw new AdminOrderError(`Cannot change an order from "${from}" to "${next}"`);
        }
        if (next === "cancelled" && current.payment_status === "paid") {
          throw new AdminOrderError("This order is already paid. Cancelling it needs a refund, which isn't supported yet");
        }

        const data: { status: string; updated_at: Date; payment_status?: string } = {
          status: next,
          updated_at: new Date(),
        };
        // Cash on delivery: the money is collected when the parcel is handed over.
        if (next === "delivered" && current.payment_method === "cod") data.payment_status = "paid";

        // Only update if the status is still what we read, so two admins can't clash.
        const result = await tx.orders.updateMany({ where: { id, status: from }, data });
        if (result.count === 0) {
          throw new AdminOrderError("This order was just changed by someone else. Reload and try again", 409);
        }

        // A cancelled order puts its books back on the shelf.
        if (next === "cancelled") {
          const items = await tx.order_items.findMany({ where: { order_id: id } });
          for (const item of items) {
            if (item.book_id) {
              await tx.books.update({
                where: { id: item.book_id },
                data: { stock: { increment: item.quantity } },
              });
            }
          }
        }
        return tx.orders.findFirstOrThrow({ where: { id } });
      });

      res.json({ message: `Order is now ${next}`, order: serializeOrder(order) });
    } catch (err) {
      if (err instanceof AdminOrderError) return res.status(err.statusCode).json({ error: err.message });
      throw err;
    }
  }),
);

export default router;
