import { NextFunction, Request, Response } from "express";

// Controllers resolve with whatever `res.json()`/`res.send()` returns
// (an Express `Response`), which this handler never reads - `unknown`
// documents that the resolved value is intentionally ignored, without
// the free pass on unsafe operations `any` would grant it.
type AsyncControllerType = (
  req: Request,
  res: Response,
  next: NextFunction
) => Promise<unknown>;

export const asyncHandler =
  (controller: AsyncControllerType): AsyncControllerType =>
  async (req, res, next) => {
    try {
      await controller(req, res, next);
    } catch (error) {
      next(error);
    }
  };
