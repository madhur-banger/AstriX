import { describe, it, expect } from "vitest";

import {
  titleSchema,
  descriptionSchema,
  assignedToSchema,
  prioritySchema,
  statusSchema,
  dueDateSchema,
  taskIdSchema,
  createTaskSchema,
  updateTaskSchema,
  paginationQuerySchema,
  taskFiltersQuerySchema,
} from "../../../src/validation/task.validation";

describe("titleSchema", () => {
  it("accepts a normal non-empty string", () => {
    expect(titleSchema.parse("Fix the bug")).toBe("Fix the bug");
  });

  it("trims leading and trailing whitespace", () => {
    expect(titleSchema.parse("   Padded Title   ")).toBe("Padded Title");
  });

  it("rejects an empty string", () => {
    expect(() => titleSchema.parse("")).toThrow();
  });

  it("rejects whitespace-only input", () => {
    expect(() => titleSchema.parse("   ")).toThrow();
  });

  it("accepts exactly 255 characters", () => {
    const value = "a".repeat(255);
    expect(titleSchema.parse(value)).toBe(value);
  });

  it("rejects more than 255 characters", () => {
    expect(() => titleSchema.parse("a".repeat(256))).toThrow();
  });

  it("rejects a number", () => {
    expect(() => titleSchema.parse(123)).toThrow();
  });

  it("rejects undefined", () => {
    expect(() => titleSchema.parse(undefined)).toThrow();
  });
});

describe("descriptionSchema", () => {
  it("accepts a normal string", () => {
    expect(descriptionSchema.parse("Some description")).toBe(
      "Some description"
    );
  });

  it("trims leading and trailing whitespace", () => {
    expect(descriptionSchema.parse("  padded  ")).toBe("padded");
  });

  it("accepts undefined", () => {
    expect(descriptionSchema.parse(undefined)).toBeUndefined();
  });

  it("rejects a number", () => {
    expect(() => descriptionSchema.parse(123)).toThrow();
  });
});

describe("assignedToSchema", () => {
  it("accepts a normal id string", () => {
    expect(assignedToSchema.parse("64f1a2b3c4d5e6f7a8b9c0d1")).toBe(
      "64f1a2b3c4d5e6f7a8b9c0d1"
    );
  });

  it("trims whitespace", () => {
    expect(assignedToSchema.parse("  64f1a2b3c4d5e6f7a8b9c0d1  ")).toBe(
      "64f1a2b3c4d5e6f7a8b9c0d1"
    );
  });

  it("rejects a non-empty string that is not a MongoDB ObjectId", () => {
    expect(() => assignedToSchema.parse("user-id")).toThrow();
  });

  it("accepts null", () => {
    expect(assignedToSchema.parse(null)).toBeNull();
  });

  it("accepts undefined", () => {
    expect(assignedToSchema.parse(undefined)).toBeUndefined();
  });

  it("rejects an empty string", () => {
    expect(() => assignedToSchema.parse("")).toThrow();
  });

  it("rejects a number", () => {
    expect(() => assignedToSchema.parse(123)).toThrow();
  });
});

describe("prioritySchema", () => {
  it.each(["LOW", "MEDIUM", "HIGH"])("accepts %s", (value) => {
    expect(prioritySchema.parse(value)).toBe(value);
  });

  it("rejects an unknown priority value", () => {
    expect(() => prioritySchema.parse("URGENT")).toThrow();
  });

  it("rejects lowercase variants", () => {
    expect(() => prioritySchema.parse("low")).toThrow();
  });

  it("rejects undefined", () => {
    expect(() => prioritySchema.parse(undefined)).toThrow();
  });

  it("rejects a number", () => {
    expect(() => prioritySchema.parse(1)).toThrow();
  });
});

describe("statusSchema", () => {
  it.each(["BACKLOG", "TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"])(
    "accepts %s",
    (value) => {
      expect(statusSchema.parse(value)).toBe(value);
    }
  );

  it("rejects an unknown status value", () => {
    expect(() => statusSchema.parse("CANCELLED")).toThrow();
  });

  it("rejects undefined", () => {
    expect(() => statusSchema.parse(undefined)).toThrow();
  });
});

describe("dueDateSchema", () => {
  it("accepts a valid ISO date string", () => {
    expect(dueDateSchema.parse("2026-01-01")).toBe("2026-01-01");
  });

  it("trims whitespace", () => {
    expect(dueDateSchema.parse("  2026-01-01  ")).toBe("2026-01-01");
  });

  it("accepts undefined", () => {
    expect(dueDateSchema.parse(undefined)).toBeUndefined();
  });

  it("rejects an unparseable date string", () => {
    expect(() => dueDateSchema.parse("not-a-date")).toThrow();
  });

  it("accepts a full ISO timestamp", () => {
    const value = "2026-01-01T10:00:00.000Z";
    expect(dueDateSchema.parse(value)).toBe(value);
  });
});

describe("taskIdSchema", () => {
  it("accepts a normal MongoDB ObjectId", () => {
    const id = "64f1a2b3c4d5e6f7a8b9c0d1";
    expect(taskIdSchema.parse(id)).toBe(id);
  });

  it("rejects a non-ObjectId string (e.g. the human-readable taskCode)", () => {
    // taskIdSchema validates the `:id` route param, which is the task's
    // Mongo _id - not `taskCode` (e.g. "task-1"), which is a separate field.
    expect(() => taskIdSchema.parse("task-1")).toThrow();
  });

  it("rejects an empty string", () => {
    expect(() => taskIdSchema.parse("")).toThrow();
  });

  it("rejects whitespace-only input", () => {
    expect(() => taskIdSchema.parse("   ")).toThrow();
  });

  it("rejects undefined", () => {
    expect(() => taskIdSchema.parse(undefined)).toThrow();
  });
});

describe("createTaskSchema", () => {
  const base = {
    title: "New Task",
    priority: "MEDIUM",
    status: "TODO",
  };

  it("accepts the minimum required fields", () => {
    const result = createTaskSchema.parse(base);
    expect(result).toEqual(base);
  });

  it("accepts all optional fields together", () => {
    const result = createTaskSchema.parse({
      ...base,
      description: "desc",
      assignedTo: "64f1a2b3c4d5e6f7a8b9c0d1",
      dueDate: "2026-01-01",
    });

    expect(result).toEqual({
      ...base,
      description: "desc",
      assignedTo: "64f1a2b3c4d5e6f7a8b9c0d1",
      dueDate: "2026-01-01",
    });
  });

  it("rejects a missing title", () => {
    expect(() =>
      createTaskSchema.parse({ priority: "MEDIUM", status: "TODO" })
    ).toThrow();
  });

  it("rejects a missing priority", () => {
    expect(() =>
      createTaskSchema.parse({ title: "T", status: "TODO" })
    ).toThrow();
  });

  it("rejects a missing status", () => {
    expect(() =>
      createTaskSchema.parse({ title: "T", priority: "MEDIUM" })
    ).toThrow();
  });

  it("rejects an invalid priority enum value", () => {
    expect(() =>
      createTaskSchema.parse({ ...base, priority: "URGENT" })
    ).toThrow();
  });

  it("rejects an invalid status enum value", () => {
    expect(() =>
      createTaskSchema.parse({ ...base, status: "CANCELLED" })
    ).toThrow();
  });

  it("rejects an unparseable dueDate", () => {
    expect(() =>
      createTaskSchema.parse({ ...base, dueDate: "not-a-date" })
    ).toThrow();
  });
});

describe("updateTaskSchema", () => {
  const base = {
    title: "Updated Task",
    priority: "HIGH",
    status: "IN_PROGRESS",
  };

  it("accepts the minimum required fields", () => {
    expect(updateTaskSchema.parse(base)).toEqual(base);
  });

  it("rejects an empty object (title/priority/status all required)", () => {
    expect(() => updateTaskSchema.parse({})).toThrow();
  });

  it("accepts assignedTo explicitly set to null (unassigning)", () => {
    const result = updateTaskSchema.parse({ ...base, assignedTo: null });
    expect(result.assignedTo).toBeNull();
  });
});

describe("paginationQuerySchema", () => {
  it("defaults to pageSize 10 and pageNumber 1 when both are absent", () => {
    expect(paginationQuerySchema.parse({})).toEqual({
      pageSize: 10,
      pageNumber: 1,
    });
  });

  it("coerces string query values into numbers", () => {
    expect(
      paginationQuerySchema.parse({ pageSize: "25", pageNumber: "3" })
    ).toEqual({
      pageSize: 25,
      pageNumber: 3,
    });
  });

  it("rejects a pageSize above the 100 cap (previously unbounded)", () => {
    expect(() => paginationQuerySchema.parse({ pageSize: "999999" })).toThrow();
  });

  it("rejects a pageSize below 1", () => {
    expect(() => paginationQuerySchema.parse({ pageSize: "0" })).toThrow();
  });

  it("rejects a non-numeric pageSize instead of silently defaulting", () => {
    expect(() => paginationQuerySchema.parse({ pageSize: "abc" })).toThrow();
  });
});

describe("taskFiltersQuerySchema", () => {
  it("parses comma-separated status/priority/assignedTo into arrays", () => {
    const result = taskFiltersQuerySchema.parse({
      status: "TODO,DONE",
      priority: "HIGH",
      assignedTo: "64f1a2b3c4d5e6f7a8b9c0d1,64f1a2b3c4d5e6f7a8b9c0d2",
    });

    expect(result.status).toEqual(["TODO", "DONE"]);
    expect(result.priority).toEqual(["HIGH"]);
    expect(result.assignedTo).toEqual([
      "64f1a2b3c4d5e6f7a8b9c0d1",
      "64f1a2b3c4d5e6f7a8b9c0d2",
    ]);
  });

  it("leaves every filter undefined when the query is empty", () => {
    const result = taskFiltersQuerySchema.parse({});
    expect(result).toEqual({});
  });

  it("rejects an invalid status value instead of silently passing it through to the DB query", () => {
    expect(() =>
      taskFiltersQuerySchema.parse({ status: "NOT_A_STATUS" })
    ).toThrow();
  });

  it("rejects a non-ObjectId assignedTo value", () => {
    expect(() =>
      taskFiltersQuerySchema.parse({ assignedTo: "not-an-object-id" })
    ).toThrow();
  });

  it("rejects a non-ObjectId projectId value", () => {
    expect(() =>
      taskFiltersQuerySchema.parse({ projectId: "not-an-object-id" })
    ).toThrow();
  });

  it("caps keyword length at 100 chars", () => {
    expect(() =>
      taskFiltersQuerySchema.parse({ keyword: "a".repeat(101) })
    ).toThrow();
    expect(
      taskFiltersQuerySchema.parse({ keyword: "a".repeat(100) }).keyword
    ).toHaveLength(100);
  });
});
