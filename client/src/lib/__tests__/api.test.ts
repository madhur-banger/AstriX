import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/axios-client", () => ({
  default: {
    get: vi.fn().mockResolvedValue({ data: {} }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    put: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

import API from "@/lib/axios-client";
import { deleteTaskMutationFn } from "@/lib/api";

describe("deleteTaskMutationFn", () => {
  it("requests the task-delete endpoint with a leading slash", async () => {
    // #given a workspace and task id
    const payload = { workspaceId: "ws1", taskId: "task1" };

    // #when deleting the task
    await deleteTaskMutationFn(payload);

    // #then the DELETE request URL has a leading slash, matching every
    // other endpoint in this file
    expect(API.delete).toHaveBeenCalledWith("/task/task1/workspace/ws1/delete");
  });
});
