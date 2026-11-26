import { NextFunction, Request, RequestHandler, Response } from "express";

// Express 4 doesn't catch errors thrown inside async handlers.
// This wrapper forwards them to the error handler instead of crashing the server.
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };
