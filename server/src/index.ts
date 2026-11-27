import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import { prisma } from "./lib/prisma";
import authRoutes from "./routes/auth";
import booksRoutes from "./routes/books";
import genresRoutes from "./routes/genres";
import cartRoutes from "./routes/cart";

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET is not set. Add it to server/.env");
}

const app = express();

app.use(cors({ origin: process.env.FRONTEND_URL || "http://localhost:5173" }));
app.use(express.json());

app.get("/api/health", async (_req, res) => {
  const books = await prisma.books.count();
  res.json({ status: "OK", books });
});

app.use("/api/auth", authRoutes);
app.use("/api/books", booksRoutes);
app.use("/api/genres", genresRoutes);
app.use("/api/cart", cartRoutes);

app.use((_req, res) => res.status(404).json({ error: "Route not found" }));

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

const port = Number(process.env.PORT) || 5002;
app.listen(port, () => console.log(`Server running on http://localhost:${port}`));
