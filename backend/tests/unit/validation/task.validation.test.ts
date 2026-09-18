import { describe, it, expect } from "vitest";

import {
  titleSchema,
  descriptionSchema,
  assignedToSchema,
  prioritySchema,
  statusSchema,
  dueDateSchema,
  createTaskSchema,
  updateTaskSchema,
  paginationQuerySchema,
  taskFiltersQuerySchema,
} from "../../../src/validation/task.validation";
import { TaskPriorityEnum, TaskStatusEnum } from "../../../src/enums/task.enum";

const validUuid = "9f8b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
const validUuid2 = "1a2b3c4d-5e6f-4a5b-8c6d-7e8f9a0b1c2e";

describe("titleSchema", () => {
  it("requires a non-empty value", () => {
    const result = titleSchema.safeParse("");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.length).toBeGreaterThan(0);
  });

  it("trims whitespace", () => {
    const result = titleSchema.safeParse("  Fix bug  ");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe("Fix bug");
  });

  it("rejects more than 255 characters", () => {
    const result = titleSchema.safeParse("a".repeat(256));
    expect(result.success).toBe(false);
  });
});

describe("descriptionSchema", () => {
  it("is optional", () => {
    const result = descriptionSchema.safeParse(undefined);
    expect(result.success).toBe(true);
  });
});

describe("assignedToSchema", () => {
  it("accepts a valid UUID", () => {
    const result = assignedToSchema.safeParse(validUuid);
    expect(result.success).toBe(true);
  });

  it("accepts null", () => {
    const result = assignedToSchema.safeParse(null);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBeNull();
  });

  it("accepts undefined (omitted)", () => {
    const result = assignedToSchema.safeParse(undefined);
    expect(result.success).toBe(true);
  });

  it("rejects a non-UUID string", () => {
    const result = assignedToSchema.safeParse("not-a-uuid");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe("Invalid assignedTo user ID");
    }
  });
});

describe("prioritySchema", () => {
  it.each(Object.values(TaskPriorityEnum))("accepts valid priority %s", (value) => {
    const result = prioritySchema.safeParse(value);
    expect(result.success).toBe(true);
  });

  it("rejects an arbitrary invalid string", () => {
    const result = prioritySchema.safeParse("URGENT");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.length).toBeGreaterThan(0);
  });
});

describe("statusSchema", () => {
  it.each(Object.values(TaskStatusEnum))("accepts valid status %s", (value) => {
    const result = statusSchema.safeParse(value);
    expect(result.success).toBe(true);
  });

  it("rejects an arbitrary invalid string", () => {
    const result = statusSchema.safeParse("ARCHIVED");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.length).toBeGreaterThan(0);
  });
});

describe("dueDateSchema", () => {
  it("accepts a valid ISO date string", () => {
    const result = dueDateSchema.safeParse("2026-12-01T00:00:00.000Z");
    expect(result.success).toBe(true);
  });

  it("rejects an unparseable date string", () => {
    const result = dueDateSchema.safeParse("not-a-date");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        "Invalid date format. Please provide a valid date string."
      );
    }
  });

  it("accepts undefined since it's optional", () => {
    const result = dueDateSchema.safeParse(undefined);
    expect(result.success).toBe(true);
  });
});

describe("createTaskSchema", () => {
  const valid = {
    title: "Ship feature",
    priority: TaskPriorityEnum.HIGH,
    status: TaskStatusEnum.TODO,
  };

  it("accepts a full valid object", () => {
    const result = createTaskSchema.safeParse({
      ...valid,
      description: "details",
      assignedTo: validUuid,
      dueDate: "2026-12-01T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid status enum value", () => {
    const result = createTaskSchema.safeParse({ ...valid, status: "NOT_A_STATUS" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === "status")).toBe(true);
    }
  });

  it("rejects an invalid priority enum value", () => {
    const result = createTaskSchema.safeParse({ ...valid, priority: "URGENT" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === "priority")).toBe(true);
    }
  });
});

describe("updateTaskSchema", () => {
  const valid = {
    title: "Ship feature",
    priority: TaskPriorityEnum.LOW,
    status: TaskStatusEnum.IN_PROGRESS,
  };

  it("accepts a full valid object", () => {
    const result = updateTaskSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("rejects an invalid status enum value", () => {
    const result = updateTaskSchema.safeParse({ ...valid, status: "NOT_A_STATUS" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === "status")).toBe(true);
    }
  });
});

describe("paginationQuerySchema", () => {
  it("defaults pageSize to 10 and pageNumber to 1 when omitted", () => {
    const result = paginationQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ pageSize: 10, pageNumber: 1 });
  });

  it("coerces numeric strings from query params", () => {
    const result = paginationQuerySchema.safeParse({ pageSize: "25" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.pageSize).toBe(25);
  });

  it("rejects pageSize above 100", () => {
    const result = paginationQuerySchema.safeParse({ pageSize: "500" });
    expect(result.success).toBe(false);
  });
});

describe("taskFiltersQuerySchema", () => {
  describe("status (commaSeparatedEnum)", () => {
    it("transforms a comma-separated list of valid values into an array", () => {
      const result = taskFiltersQuerySchema.safeParse({
        status: `${TaskStatusEnum.TODO},${TaskStatusEnum.DONE}`,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toEqual([TaskStatusEnum.TODO, TaskStatusEnum.DONE]);
      }
    });

    it("fails the whole field when one value is invalid", () => {
      const result = taskFiltersQuerySchema.safeParse({
        status: `${TaskStatusEnum.TODO},NOT_A_STATUS`,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path[0] === "status")).toBe(true);
      }
    });

    it("transforms an omitted field into undefined", () => {
      const result = taskFiltersQuerySchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.status).toBeUndefined();
    });

    it("transforms an empty string into undefined", () => {
      const result = taskFiltersQuerySchema.safeParse({ status: "" });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.status).toBeUndefined();
    });
  });

  describe("priority (commaSeparatedEnum)", () => {
    it("transforms a comma-separated list of valid values into an array", () => {
      const result = taskFiltersQuerySchema.safeParse({
        priority: `${TaskPriorityEnum.LOW},${TaskPriorityEnum.HIGH}`,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.priority).toEqual([TaskPriorityEnum.LOW, TaskPriorityEnum.HIGH]);
      }
    });

    it("fails the whole field when one value is invalid", () => {
      const result = taskFiltersQuerySchema.safeParse({ priority: "URGENT" });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path[0] === "priority")).toBe(true);
      }
    });
  });

  describe("assignedTo", () => {
    it("transforms a comma-separated list of UUIDs into an array", () => {
      const result = taskFiltersQuerySchema.safeParse({
        assignedTo: `${validUuid},${validUuid2}`,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.assignedTo).toEqual([validUuid, validUuid2]);
      }
    });

    it("fails when the list contains a non-UUID entry", () => {
      const result = taskFiltersQuerySchema.safeParse({
        assignedTo: `${validUuid},not-a-uuid`,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path[0] === "assignedTo")).toBe(true);
      }
    });
  });

  describe("keyword", () => {
    it("trims the value", () => {
      const result = taskFiltersQuerySchema.safeParse({ keyword: "  search term  " });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.keyword).toBe("search term");
    });

    it("rejects more than 100 characters", () => {
      const result = taskFiltersQuerySchema.safeParse({ keyword: "a".repeat(101) });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path[0] === "keyword")).toBe(true);
      }
    });
  });

  describe("projectId", () => {
    it("accepts a valid UUID", () => {
      const result = taskFiltersQuerySchema.safeParse({ projectId: validUuid });
      expect(result.success).toBe(true);
    });

    it("rejects a non-UUID value", () => {
      const result = taskFiltersQuerySchema.safeParse({ projectId: "not-a-uuid" });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path[0] === "projectId")).toBe(true);
      }
    });

    it("is optional", () => {
      const result = taskFiltersQuerySchema.safeParse({});
      expect(result.success).toBe(true);
    });
  });
});
