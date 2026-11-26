import "dotenv/config";
import express from "express";
import cors from "cors";
import { PrismaClient } from "./generated/prisma/client";

const prisma = new PrismaClient();
const app = express();

app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json());

app.get("/api/health", async (_req, res) => {
  const books = await prisma.books.count();
  res.json({ status: "OK", books });
});

const port = Number(process.env.PORT) || 5002;
app.listen(port, () => console.log(`Server running on http://localhost:${port}`));
