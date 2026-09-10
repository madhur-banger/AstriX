/**
 * UNIT TESTS: project.controller.ts
 * --------------------------------------
 * Mirrors tests/unit/controllers/workspace.controller.test.ts: controllers
 * are thin (parse/validate input, call a service, shape the HTTP response),
 * so every dependency is mocked here -
 *   - the service functions (createProjectService, etc.)
 *   - getMemberRoleInWorkspace (from member.service)
 *   - roleGuard (permission check util)
 * and we verify ONLY that the controller:
 *   1. calls the right service with the right arguments
 *   2. returns the right HTTP status code
 *   3. shapes the JSON response body correctly
 *   4. correctly triggers permission checks before mutating actions
 *
 * See workspace.controller.test.ts for the asyncHandler caveat: a thrown/
 * rejected inner handler is caught and forwarded to next(error), not thrown.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  createProjectController,
  getAllProjectsInWorkspaceController,
  getProjectByIdAndWorkspaceIdController,
  getProjectAnalyticsController,
  updateProjectController,
  deleteProjectController,
} from "../../../src/controllers/project.controller";

import * as projectService from "../../../src/services/project.service";
import * as memberService from "../../../src/services/member.service";
import { roleGuard } from "../../../src/utils/roleGuard";
import { createMockReqRes } from "../../setup/mockExpress";
import { buildFakeProject } from "../../setup/testFixtures";

vi.mock("../../../src/services/project.service");
vi.mock("../../../src/services/member.service");
vi.mock("../../../src/utils/roleGuard");

describe("createProjectController", () => {
  beforeEach(() => vi.resetAllMocks());

  it("parses the body, checks CREATE_PROJECT permission, and responds 201", async () => {
    const fakeProject = buildFakeProject({ name: "New Project" });
    vi.mocked(memberService.getMemberRoleInWorkspace).mockResolvedValue({
      role: "OWNER",
    } as any);
    vi.mocked(projectService.createProjectService).mockResolvedValue({
      project: fakeProject,
    } as any);

    const { req, res, next } = createMockReqRes({
      body: { name: "New Project" },
      params: { workspaceId: "64f1a2b3c4d5e6f7a8b9c0d1" },
      user: { _id: "user-1" },
    });

    await createProjectController(req, res, next);

    expect(memberService.getMemberRoleInWorkspace).toHaveBeenCalledWith(
      "user-1",
      "64f1a2b3c4d5e6f7a8b9c0d1"
    );
    expect(roleGuard).toHaveBeenCalledWith("OWNER", ["CREATE_PROJECT"]);
    expect(projectService.createProjectService).toHaveBeenCalledWith(
      "user-1",
      "64f1a2b3c4d5e6f7a8b9c0d1",
      { name: "New Project" }
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Project created successfully",
        project: fakeProject,
      })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("propagates validation errors to next() instead of crashing", async () => {
    // No "name" field at all -> createProjectSchema.parse() should throw
    // a ZodError BEFORE the service is ever called.
    const { req, res, next } = createMockReqRes({
      body: {},
      params: { workspaceId: "64f1a2b3c4d5e6f7a8b9c0d1" },
    });

    await createProjectController(req, res, next);

    expect(projectService.createProjectService).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it("does not call the service if roleGuard throws (insufficient permission)", async () => {
    vi.mocked(memberService.getMemberRoleInWorkspace).mockResolvedValue({
      role: "VIEW_ONLY",
    } as any);
    vi.mocked(roleGuard).mockImplementation(() => {
      throw new Error("Forbidden");
    });

    const { req, res, next } = createMockReqRes({
      body: { name: "New Project" },
      params: { workspaceId: "64f1a2b3c4d5e6f7a8b9c0d1" },
    });

    await createProjectController(req, res, next);

    expect(projectService.createProjectService).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });
});

describe("getAllProjectsInWorkspaceController", () => {
  beforeEach(() => vi.resetAllMocks());

  it("checks VIEW_ONLY permission, applies default pagination, and returns 200", async () => {
    const fakeProjects = [buildFakeProject(), buildFakeProject()];
    vi.mocked(memberService.getMemberRoleInWorkspace).mockResolvedValue({
      role: "MEMBER",
    } as any);
    vi.mocked(projectService.getProjectsInWorkspaceService).mockResolvedValue({
      projects: fakeProjects,
      totalCount: 2,
      totalPages: 1,
      skip: 0,
    } as any);

    const { req, res, next } = createMockReqRes({
      params: { workspaceId: "64f1a2b3c4d5e6f7a8b9c0d1" },
      user: { _id: "user-1" },
    });

    await getAllProjectsInWorkspaceController(req, res, next);

    expect(roleGuard).toHaveBeenCalledWith("MEMBER", ["VIEW_ONLY"]);
    // No pageSize/pageNumber in the query -> defaults of 10 and 1.
    expect(projectService.getProjectsInWorkspaceService).toHaveBeenCalledWith(
      "64f1a2b3c4d5e6f7a8b9c0d1",
      10,
      1
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Project fetched successfully",
        projects: fakeProjects,
        pagination: expect.objectContaining({
          totalCount: 2,
          pageSize: 10,
          pageNumber: 1,
          totalPages: 1,
          skip: 0,
          limit: 10,
        }),
      })
    );
  });

  it("parses pageSize/pageNumber from the query string", async () => {
    vi.mocked(memberService.getMemberRoleInWorkspace).mockResolvedValue({
      role: "MEMBER",
    } as any);
    vi.mocked(projectService.getProjectsInWorkspaceService).mockResolvedValue({
      projects: [],
      totalCount: 0,
      totalPages: 0,
      skip: 20,
    } as any);

    const { req, res, next } = createMockReqRes({
      params: { workspaceId: "64f1a2b3c4d5e6f7a8b9c0d1" },
      query: { pageSize: "5", pageNumber: "3" },
    });

    await getAllProjectsInWorkspaceController(req, res, next);

    expect(projectService.getProjectsInWorkspaceService).toHaveBeenCalledWith(
      "64f1a2b3c4d5e6f7a8b9c0d1",
      5,
      3
    );
  });

  it("propagates an error to next() when the user isn't a member", async () => {
    vi.mocked(memberService.getMemberRoleInWorkspace).mockRejectedValue(
      new Error("Not a member")
    );

    const { req, res, next } = createMockReqRes({
      params: { workspaceId: "64f1a2b3c4d5e6f7a8b9c0d1" },
    });

    await getAllProjectsInWorkspaceController(req, res, next);

    expect(projectService.getProjectsInWorkspaceService).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });
});

describe("getProjectByIdAndWorkspaceIdController", () => {
  beforeEach(() => vi.resetAllMocks());

  it("checks VIEW_ONLY permission and returns the project with 200", async () => {
    const fakeProject = buildFakeProject();
    vi.mocked(memberService.getMemberRoleInWorkspace).mockResolvedValue({
      role: "MEMBER",
    } as any);
    vi.mocked(
      projectService.getProjectByIdAndWorkspaceIdService
    ).mockResolvedValue({ project: fakeProject } as any);

    const { req, res, next } = createMockReqRes({
      params: {
        id: String(fakeProject._id),
        workspaceId: "64f1a2b3c4d5e6f7a8b9c0d1",
      },
      user: { _id: "user-1" },
    });

    await getProjectByIdAndWorkspaceIdController(req, res, next);

    expect(roleGuard).toHaveBeenCalledWith("MEMBER", ["VIEW_ONLY"]);
    expect(
      projectService.getProjectByIdAndWorkspaceIdService
    ).toHaveBeenCalledWith("64f1a2b3c4d5e6f7a8b9c0d1", String(fakeProject._id));
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Project fetched successfully",
        project: fakeProject,
      })
    );
  });

  it("propagates a not-found error to next() when the service throws", async () => {
    vi.mocked(memberService.getMemberRoleInWorkspace).mockResolvedValue({
      role: "MEMBER",
    } as any);
    vi.mocked(
      projectService.getProjectByIdAndWorkspaceIdService
    ).mockRejectedValue(new Error("Project not found"));

    const { req, res, next } = createMockReqRes({
      params: {
        id: "64f1a2b3c4d5e6f7a8b9c0d2",
        workspaceId: "64f1a2b3c4d5e6f7a8b9c0d1",
      },
    });

    await getProjectByIdAndWorkspaceIdController(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("propagates validation errors when the project id is blank", async () => {
    const { req, res, next } = createMockReqRes({
      params: { id: "", workspaceId: "64f1a2b3c4d5e6f7a8b9c0d1" },
    });

    await getProjectByIdAndWorkspaceIdController(req, res, next);

    expect(memberService.getMemberRoleInWorkspace).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });
});

describe("getProjectAnalyticsController", () => {
  beforeEach(() => vi.resetAllMocks());

  it("checks VIEW_ONLY permission and returns analytics with 200", async () => {
    const fakeAnalytics = {
      totalTasks: 10,
      overdueTasks: 2,
      completedTasks: 5,
    };
    vi.mocked(memberService.getMemberRoleInWorkspace).mockResolvedValue({
      role: "MEMBER",
    } as any);
    vi.mocked(projectService.getProjectAnalyticsService).mockResolvedValue({
      analytics: fakeAnalytics,
    } as any);

    const { req, res, next } = createMockReqRes({
      params: {
        id: "64f1a2b3c4d5e6f7a8b9c0d2",
        workspaceId: "64f1a2b3c4d5e6f7a8b9c0d1",
      },
      user: { _id: "user-1" },
    });

    await getProjectAnalyticsController(req, res, next);

    expect(roleGuard).toHaveBeenCalledWith("MEMBER", ["VIEW_ONLY"]);
    expect(projectService.getProjectAnalyticsService).toHaveBeenCalledWith(
      "64f1a2b3c4d5e6f7a8b9c0d1",
      "64f1a2b3c4d5e6f7a8b9c0d2"
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Project analytics retrieved successfully",
        analytics: fakeAnalytics,
      })
    );
  });

  it("propagates an error to next() when the project doesn't belong to the workspace", async () => {
    vi.mocked(memberService.getMemberRoleInWorkspace).mockResolvedValue({
      role: "MEMBER",
    } as any);
    vi.mocked(projectService.getProjectAnalyticsService).mockRejectedValue(
      new Error("Project not found or does not belong to this workspace")
    );

    const { req, res, next } = createMockReqRes({
      params: {
        id: "64f1a2b3c4d5e6f7a8b9c0d2",
        workspaceId: "64f1a2b3c4d5e6f7a8b9c0d1",
      },
    });

    await getProjectAnalyticsController(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });
});

describe("updateProjectController", () => {
  beforeEach(() => vi.resetAllMocks());

  it("checks EDIT_PROJECT permission and returns the updated project with 200", async () => {
    const fakeProject = buildFakeProject({ name: "Renamed" });
    vi.mocked(memberService.getMemberRoleInWorkspace).mockResolvedValue({
      role: "OWNER",
    } as any);
    vi.mocked(projectService.updateProjectService).mockResolvedValue({
      project: fakeProject,
    } as any);

    const { req, res, next } = createMockReqRes({
      params: {
        id: "64f1a2b3c4d5e6f7a8b9c0d2",
        workspaceId: "64f1a2b3c4d5e6f7a8b9c0d1",
      },
      body: { name: "Renamed", description: "d" },
      user: { _id: "user-1" },
    });

    await updateProjectController(req, res, next);

    expect(roleGuard).toHaveBeenCalledWith("OWNER", ["EDIT_PROJECT"]);
    expect(projectService.updateProjectService).toHaveBeenCalledWith(
      "64f1a2b3c4d5e6f7a8b9c0d1",
      "64f1a2b3c4d5e6f7a8b9c0d2",
      { name: "Renamed", description: "d" }
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Project updated successfully",
        project: fakeProject,
      })
    );
  });

  it("does not call the service if roleGuard throws (insufficient permission)", async () => {
    vi.mocked(memberService.getMemberRoleInWorkspace).mockResolvedValue({
      role: "VIEW_ONLY",
    } as any);
    vi.mocked(roleGuard).mockImplementation(() => {
      throw new Error("Forbidden");
    });

    const { req, res, next } = createMockReqRes({
      params: {
        id: "64f1a2b3c4d5e6f7a8b9c0d2",
        workspaceId: "64f1a2b3c4d5e6f7a8b9c0d1",
      },
      body: { name: "Renamed" },
    });

    await updateProjectController(req, res, next);

    expect(projectService.updateProjectService).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it("propagates validation errors to next() when name is missing", async () => {
    const { req, res, next } = createMockReqRes({
      params: {
        id: "64f1a2b3c4d5e6f7a8b9c0d2",
        workspaceId: "64f1a2b3c4d5e6f7a8b9c0d1",
      },
      body: { description: "no name provided" },
    });

    await updateProjectController(req, res, next);

    expect(memberService.getMemberRoleInWorkspace).not.toHaveBeenCalled();
    expect(projectService.updateProjectService).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });
});

describe("deleteProjectController", () => {
  beforeEach(() => vi.resetAllMocks());

  it("checks DELETE_PROJECT permission and responds 200 on success", async () => {
    vi.mocked(memberService.getMemberRoleInWorkspace).mockResolvedValue({
      role: "OWNER",
    } as any);
    vi.mocked(projectService.deleteProjectService).mockResolvedValue(
      undefined as any
    );

    const { req, res, next } = createMockReqRes({
      params: {
        id: "64f1a2b3c4d5e6f7a8b9c0d2",
        workspaceId: "64f1a2b3c4d5e6f7a8b9c0d1",
      },
      user: { _id: "user-1" },
    });

    await deleteProjectController(req, res, next);

    expect(roleGuard).toHaveBeenCalledWith("OWNER", ["DELETE_PROJECT"]);
    expect(projectService.deleteProjectService).toHaveBeenCalledWith(
      "64f1a2b3c4d5e6f7a8b9c0d1",
      "64f1a2b3c4d5e6f7a8b9c0d2"
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Project deleted successfully",
      })
    );
  });

  it("does not call the service if roleGuard throws (insufficient permission)", async () => {
    vi.mocked(memberService.getMemberRoleInWorkspace).mockResolvedValue({
      role: "VIEW_ONLY",
    } as any);
    vi.mocked(roleGuard).mockImplementation(() => {
      throw new Error("Forbidden");
    });

    const { req, res, next } = createMockReqRes({
      params: {
        id: "64f1a2b3c4d5e6f7a8b9c0d2",
        workspaceId: "64f1a2b3c4d5e6f7a8b9c0d1",
      },
    });

    await deleteProjectController(req, res, next);

    expect(projectService.deleteProjectService).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it("propagates an error to next() when the project doesn't belong to the workspace", async () => {
    vi.mocked(memberService.getMemberRoleInWorkspace).mockResolvedValue({
      role: "OWNER",
    } as any);
    vi.mocked(projectService.deleteProjectService).mockRejectedValue(
      new Error(
        "Project not found or does not belong to the specified workspace"
      )
    );

    const { req, res, next } = createMockReqRes({
      params: {
        id: "64f1a2b3c4d5e6f7a8b9c0d2",
        workspaceId: "64f1a2b3c4d5e6f7a8b9c0d1",
      },
    });

    await deleteProjectController(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });
});
